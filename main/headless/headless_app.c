/* CORE-ESP32-C3: UART0 through CH343P, no screen, GPS or LVGL. */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdatomic.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "driver/gpio.h"
#include "driver/uart_vfs.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"
#include "ui.h"
#include "data.h"
#include "status_logic.h"
#include "command_logic.h"
#include "dual_control.h"
#include "headless_app.h"
#include "control_service.h"
#include "phone_service.h"
#include "journal.h"

#define TAG "HEADLESS"
#define DISCOVERED_MAX 10
#define STORE_VERSION 1u

camera_state_t g_camera_states[NUM_CAMERAS];
ui_state_t g_ui_state;
uint32_t g_device_id;
int g_current_wake_camera_index = -1;
static SemaphoreHandle_t state_mutex;
static QueueHandle_t discovery_queue, work_queue;
static bool protocol_ready[2];
static _Atomic bool worker_busy;
static QueueHandle_t observation_queue;
static cap_sample_t latest_samples[2];
static _Atomic bool observation_overflow;
typedef struct { int slot; cap_sample_t sample; } observation_t;
static uint8_t remote_mac[6];
/* The capture service owns the take lifecycle; pairing remains in NVS. */
static dc_button_t button;
static uint32_t error_since;
static bool error_active;

typedef struct {
    char name[64];
    uint8_t mac[6];
    uint32_t device_id;
    int8_t rssi;
    bool name_only;
} discovery_t;
static discovery_t discovered[DISCOVERED_MAX];
static int discovered_count;
typedef struct { bool scan; int slot; discovery_t camera; } work_t;
typedef struct {
    uint32_t version, device_id;
    char name[64];
    uint8_t mac[6];
    uint8_t paired, reserved;
} stored_pair_t;

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time()/1000); }
static uint64_t monotonic_ms(void) { return (uint64_t)(esp_timer_get_time()/1000); }
void headless_state_lock(void) { xSemaphoreTake(state_mutex,portMAX_DELAY); }
void headless_state_unlock(void) { xSemaphoreGive(state_mutex); }
void wake_queue_notify_camera_woke_up(int slot) { (void)slot; }
void ui_initiate_boot_scan_connections(void) { /* Headless connection worker owns reconnects. */ }
const char *ui_get_camera_model_name(uint32_t id) {
    switch(id) {
        case 0xFF33:return "Action 4";
        case 0xFF44:return "Action 5 Pro";
        case 0xFF55:return "Action 6";
        case 0xFF66:return "Osmo 360";
        default:return "DJI Camera";
    }
}

/* These callbacks run on the BLE host: copy only, never log, connect or write NVS. */
void ui_pairing_add_discovered_camera(const char *name,const uint8_t *mac,int8_t rssi,uint32_t id) {
    discovery_t d={.device_id=id,.rssi=rssi};
    snprintf(d.name,sizeof(d.name),"%s",name);
    memcpy(d.mac,mac,6);
    (void)xQueueSend(discovery_queue,&d,0);
}
void ui_pairing_update_discovered_camera_name(const char *name,const uint8_t *mac) {
    discovery_t d={.name_only=true};
    snprintf(d.name,sizeof(d.name),"%s",name);
    memcpy(d.mac,mac,6);
    (void)xQueueSend(discovery_queue,&d,0);
}
static void status_received(int slot,void *data) {
    if (slot<0 || slot>=2 || !data) { free(data);return; }
    headless_state_lock();
    if (!protocol_ready[slot] || !ble_is_camera_connected(slot)) {
        headless_state_unlock();
        free(data);
        return;
    }
    update_camera_state_handler(slot,data);
    /* Use the same monotonic clock as command confirmation (not tick quantization). */
    g_camera_states[slot].last_status_timestamp=now_ms();
    latest_samples[slot]=(cap_sample_t){
        .connected=true,.valid=g_camera_states[slot].is_initialized,
        .video=g_camera_states[slot].camera_mode==CAMERA_MODE_NORMAL,
        .sleeping=g_camera_states[slot].is_sleeping,.recording=g_camera_states[slot].is_recording,
        .status_ms=(uint64_t)(esp_timer_get_time()/1000),.record_time=g_camera_states[slot].record_time,
        .battery=g_camera_states[slot].camera_bat_percentage};
    observation_t observation={.slot=slot,.sample=latest_samples[slot]};
    if(xQueueSend(observation_queue,&observation,0)!=pdTRUE)atomic_store(&observation_overflow,true);
    headless_state_unlock();
}
static void new_status_received(int slot,void *data) {
    if (slot<0 || slot>=2 || !data) { free(data);return; }
    headless_state_lock();
    if (!protocol_ready[slot] || !ble_is_camera_connected(slot)) {
        headless_state_unlock();
        free(data);
        return;
    }
    update_new_camera_state_handler(slot,data);
    headless_state_unlock();
}

esp_err_t save_all_cameras_to_nvs(void) {
    stored_pair_t stored[2]={0};
    headless_state_lock();
    for(int i=0;i<2;i++) {
        const camera_state_t *c=&g_camera_states[i];
        stored[i].version=STORE_VERSION;
        stored[i].paired=c->is_paired;
        stored[i].device_id=c->device_id;
        stored[i].reserved=c->camera_reserved;
        memcpy(stored[i].mac,c->camera_mac,6);
        snprintf(stored[i].name,sizeof(stored[i].name),"%s",c->camera_name);
    }
    headless_state_unlock();
    nvs_handle_t nvs;
    esp_err_t err=nvs_open("headless",NVS_READWRITE,&nvs);
    if(err!=ESP_OK)return err;
    for(int i=0;i<2 && err==ESP_OK;i++) {
        char key[12];snprintf(key,sizeof(key),"camera%d",i);
        err=nvs_set_blob(nvs,key,&stored[i],sizeof(stored[i]));
    }
    if(err==ESP_OK)err=nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}
static void load_pairings(void) {
    nvs_handle_t nvs;
    ESP_ERROR_CHECK(nvs_open("headless",NVS_READWRITE,&nvs));
    esp_err_t err=nvs_get_u32(nvs,"remote_id",&g_device_id);
    if(err==ESP_ERR_NVS_NOT_FOUND) {
        do { g_device_id=esp_random(); } while(g_device_id==0);
        ESP_ERROR_CHECK(nvs_set_u32(nvs,"remote_id",g_device_id));
        ESP_ERROR_CHECK(nvs_commit(nvs));
    } else ESP_ERROR_CHECK(err);
    for(int i=0;i<2;i++) {
        char key[12];snprintf(key,sizeof(key),"camera%d",i);
        stored_pair_t p={0};size_t size=sizeof(p);
        err=nvs_get_blob(nvs,key,&p,&size);
        if(err==ESP_ERR_NVS_NOT_FOUND)continue;
        if(err!=ESP_OK || size!=sizeof(p) || p.version!=STORE_VERSION) {
            ESP_LOGE(TAG,"Slot %d pairing unreadable; preserving storage",i+1);
            continue;
        }
        if(!p.paired)continue;
        camera_state_t *c=&g_camera_states[i];
        c->is_paired=true;c->device_id=p.device_id;c->camera_reserved=p.reserved;
        c->connection_state=CAM_STATE_PAIRED_DISCONNECTED;
        snprintf(c->camera_name,sizeof(c->camera_name),"%.*s",(int)sizeof(p.name)-1,p.name);
        memcpy(c->camera_mac,p.mac,6);
    }
    nvs_close(nvs);
}

static bool connect_slot(int slot,const discovery_t *new_camera) {
    camera_state_t prior;
    headless_state_lock();
    prior=g_camera_states[slot];
    camera_state_t *c=&g_camera_states[slot];
    protocol_ready[slot]=false;
    c->is_initialized=false;c->last_status_timestamp=0;c->is_recording=false;
    latest_samples[slot]=(cap_sample_t){0};
    c->is_connected=false;c->is_sleeping=false;c->snapshot_pending=false;
    c->connection_state=CAM_STATE_CONNECTING;
    if(new_camera) {
        snprintf(c->camera_name,sizeof(c->camera_name),"%s",new_camera->name);
        memcpy(c->camera_mac,new_camera->mac,6);
        c->device_id=new_camera->device_id;
        c->camera_reserved=(uint8_t)slot;
    }
    char name[64];uint8_t mac[6];
    memcpy(name,c->camera_name,sizeof(name));memcpy(mac,c->camera_mac,6);
    headless_state_unlock();
    ESP_LOGI(TAG,"Slot %d: %s %s; approve pairing on camera if prompted",slot+1,new_camera?"pairing":"reconnecting",name);
    ble_set_target_device(slot,name,mac);
    int result=connect_logic_ble_connect(slot,SCAN_MODE_SLOT_RECONNECT);
    /* History-aware mode works for both a new remote and a saved connection:
     * the camera requests screen confirmation only when its history needs it. */
    if(result==0) result=connect_logic_protocol_connect(slot,g_device_id,6,(const int8_t*)remote_mac,0,0,0,(uint8_t)slot);
    if(result!=0) {
        (void)ble_stop_scan();
        if(ble_is_camera_connected(slot))(void)ble_disconnect(slot);
        connect_logic_set_slot_connecting(slot,false);
        headless_state_lock();
        g_camera_states[slot]=prior;
        g_camera_states[slot].is_connected=false;
        g_camera_states[slot].is_initialized=false;
        g_camera_states[slot].is_recording=false;
        g_camera_states[slot].last_status_timestamp=0;
        g_camera_states[slot].connection_state=prior.is_paired?CAM_STATE_PAIRED_DISCONNECTED:CAM_STATE_UNPAIRED;
        headless_state_unlock();
        ESP_LOGW(TAG,"Slot %d connection failed; will retry saved pairings",slot+1);
        return false;
    }
    headless_state_lock();
    g_camera_states[slot].is_paired=true;
    g_camera_states[slot].is_connected=true;
    g_camera_states[slot].connection_state=CAM_STATE_CONNECTED;
    protocol_ready[slot]=true;
    headless_state_unlock();
    if(new_camera) {
        esp_err_t err=save_all_cameras_to_nvs();
        if(err!=ESP_OK)ESP_LOGE(TAG,"Slot %d paired but NOT saved: %s",slot+1,esp_err_to_name(err));
        else ESP_LOGI(TAG,"Slot %d pairing saved",slot+1);
    }
    ESP_LOGI(TAG,"Slot %d protocol connected; waiting for camera status",slot+1);
    return true;
}
static void connection_worker(void *unused) {
    (void)unused;
    uint32_t last_attempt[2]={0};
    bool attempted[2]={false,false};
    int next_slot=0;
    bool discovering=false;
    for(;;) {
        work_t work;
        if(xQueueReceive(work_queue,&work,pdMS_TO_TICKS(100))==pdTRUE) {
            if(ble_is_scanning()) {
                (void)ble_stop_scan();
                vTaskDelay(pdMS_TO_TICKS(100));
            }
            discovering=false;
            atomic_store(&worker_busy,true);
            if(work.scan) {
                esp_err_t err=ble_start_scan(SCAN_MODE_PAIRING,0,10000);
                discovering=err==ESP_OK;
                ESP_LOGI(TAG,"Discovery %s",discovering?"started for 10s; then use list":"failed");
            } else {
                (void)connect_slot(work.slot,&work.camera);
                last_attempt[work.slot]=now_ms();attempted[work.slot]=true;
            }
            atomic_store(&worker_busy,false);
        }
        if(discovering) {
            if(ble_is_scanning())continue;
            discovering=false;
            ESP_LOGI(TAG,"Discovery complete; use list and pair <slot> <index>");
        }
        int slot=next_slot;next_slot=(next_slot+1)%2;
        headless_state_lock();
        bool need=g_camera_states[slot].is_paired && !ble_is_camera_connected(slot);
        headless_state_unlock();
        uint32_t now=now_ms();
        if(need && (!attempted[slot] || (uint32_t)(now-last_attempt[slot])>=5000)) {
            atomic_store(&worker_busy,true);
            (void)connect_slot(slot,NULL);
            atomic_store(&worker_busy,false);
            last_attempt[slot]=now_ms();attempted[slot]=true;
        }
    }
}

static void snapshot(cap_sample_t out[2]) {
    headless_state_lock();
    for(int i=0;i<2;i++) {
        out[i]=latest_samples[i];
        out[i].connected=protocol_ready[i] && ble_is_camera_connected(i);
        if(!out[i].connected)out[i].valid=false;
    }
    headless_state_unlock();
}
static bool record_dispatch(void *ctx,int slot,bool start) {
    (void)ctx;
    return (start?command_logic_start_record_async(slot):command_logic_stop_record_async(slot))==ESP_OK;
}
static void indicate_error(void) { error_since=now_ms();error_active=true; }
static void recording_button(void) {
    cap_sample_t samples[2];snapshot(samples);
    control_service_button(samples,(uint64_t)(esp_timer_get_time()/1000));
    if(!control_service_active())indicate_error();
}
static void print_discovered(void) {
    for(int i=0;i<discovered_count;i++) {
        const discovery_t *d=&discovered[i];
        ESP_LOGI(TAG,"[%d] %s MAC=%02X:%02X:%02X:%02X:%02X:%02X RSSI=%d %s",i+1,d->name,
            d->mac[0],d->mac[1],d->mac[2],d->mac[3],d->mac[4],d->mac[5],d->rssi,ui_get_camera_model_name(d->device_id));
    }
    if(!discovered_count)ESP_LOGI(TAG,"No discovered cameras; power on camera, disconnect Mimo/other remotes, use scan");
}
static void console_command(const char *line) {
    cap_sample_t samples[2];snapshot(samples);
    if(line[0]=='{') {
        const char *end=NULL;
        cJSON *command=cJSON_ParseWithOpts(line,&end,true);
        const control_request_t origin={.transport=CONTROL_USB};
        control_service_command(command,samples,monotonic_ms(),&origin);
        cJSON_Delete(command);
        return;
    }
    if(!strcmp(line,"debug")) {
        const char *tags[]={"BLE","DATA","LOGIC_CONNECT","LOGIC_COMMAND"};
        for(unsigned i=0;i<sizeof(tags)/sizeof(tags[0]);i++)esp_log_level_set(tags[i],ESP_LOG_INFO);
        ESP_LOGI(TAG,"BLE/protocol diagnostics enabled; quiet disables them");
    }
    else if(!strcmp(line,"quiet")) {
        esp_log_level_set("*",ESP_LOG_WARN);
        esp_log_level_set(TAG,ESP_LOG_INFO);
        ESP_LOGI(TAG,"BLE/protocol diagnostics disabled");
    }
    else if(!strcmp(line,"list"))print_discovered();
    else if(!strcmp(line,"scan")) {
        if(control_service_active()) { ESP_LOGW(TAG,"BUSY: close the take before scan");return; }
        discovered_count=0;
        work_t w={.scan=true};
        if(xQueueSend(work_queue,&w,0)!=pdTRUE)ESP_LOGW(TAG,"Connection queue busy");
        else ESP_LOGI(TAG,"Discovery queued; existing camera links stay connected");
    } else {
        int slot,index;char extra;
        if(sscanf(line,"pair %d %d %c",&slot,&index,&extra)==2) {
            if(slot<1 || slot>2 || index<1 || index>discovered_count) { ESP_LOGW(TAG,"Use pair <1|2> <index from list>");return; }
            headless_state_lock();
            bool paired=g_camera_states[slot-1].is_paired;
            bool duplicate=g_camera_states[2-slot].is_paired && !memcmp(g_camera_states[2-slot].camera_mac,discovered[index-1].mac,6);
            headless_state_unlock();
            if(paired || duplicate || control_service_active() || atomic_load(&worker_busy)) {
                ESP_LOGW(TAG,"Pair rejected: slot occupied, duplicate camera or operation busy");return;
            }
            work_t w={.slot=slot-1,.camera=discovered[index-1]};
            if(xQueueSend(work_queue,&w,0)!=pdTRUE)ESP_LOGW(TAG,"Connection queue busy");
        } else ESP_LOGI(TAG,"Commands: scan | list | pair <1|2> <index> | debug | quiet; JSON: INIT_PROJECT, SELECT_ACTION, START, STOP, TIME_SYNC, GET_STATUS, GET_LOG_INFO, EXPORT_LOG, GET_LOG, MARK_DISCARD, REASSIGN, RESET_PROJECT");
    }
}
static void receive_discovery(void) {
    discovery_t d;
    while(xQueueReceive(discovery_queue,&d,0)==pdTRUE) {
        int index=0;
        while(index<discovered_count && memcmp(discovered[index].mac,d.mac,6))index++;
        if(index==DISCOVERED_MAX)continue;
        /* A scan-response name may update a DJI advertisement, but cannot
         * introduce an unrelated BLE device into the pairing list. */
        if(index==discovered_count && d.name_only)continue;
        if(index==discovered_count) { discovered_count++;discovered[index]=d; }
        else {
            if(strcmp(d.name,"DJI Camera"))snprintf(discovered[index].name,sizeof(discovered[index].name),"%s",d.name);
            if(d.device_id) { discovered[index].device_id=d.device_id;discovered[index].rssi=d.rssi; }
        }
    }
}
static void update_feedback(void) {
    if(atomic_exchange(&observation_overflow,false))control_service_observation_lost();
    observation_t observation;
    static cap_sample_t observed[2];
    while(xQueueReceive(observation_queue,&observation,0)==pdTRUE) {
        observed[observation.slot]=observation.sample;
        /* Replay queued transitions at their observation time, not export end. */
        control_service_observe(observed,observation.sample.status_ms);
    }
    cap_sample_t samples[2];snapshot(samples);
    uint64_t now=(uint64_t)(esp_timer_get_time()/1000);
    memcpy(observed,samples,sizeof(observed));
    control_service_observe(samples,now);
    if(error_active && (uint32_t)(now_ms()-error_since)>=3000)error_active=false;
    const int pins[2]={CONFIG_HEADLESS_LED1_GPIO,CONFIG_HEADLESS_LED2_GPIO};
    for(int i=0;i<2;i++) {
        int mode=control_service_led(i,&samples[i],now);
        bool on=mode==1 || (mode==2 && (now%1000)<500) || (mode==3 && (now%160)<80);
        if(error_active)on=(now%160)<80;
        if(pins[i]>=0)gpio_set_level(pins[i],on);
    }
}
void app_main(void) {
    state_mutex=xSemaphoreCreateMutex();
    discovery_queue=xQueueCreate(16,sizeof(discovery_t));
    work_queue=xQueueCreate(1,sizeof(work_t));
    observation_queue=xQueueCreate(32,sizeof(observation_t));
    if(!state_mutex || !discovery_queue || !work_queue || !observation_queue) { ESP_LOGE(TAG,"Failed to allocate queues/mutex");return; }
    /* No automatic erase: an NVS failure must not silently destroy pairings. */
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_read_mac(remote_mac,ESP_MAC_BT));
    load_pairings();
    esp_log_level_set("*",ESP_LOG_WARN);
    esp_log_level_set(TAG,ESP_LOG_INFO);
    ESP_LOGI(TAG,"DJI-Remote V1 capture journal: BOOT starts/stops a take; CH343P 115200 8N1");
    if(!journal_open("/journal"))ESP_LOGE(TAG,"Journal unavailable: %s; START disabled, stop/export remain available",journal_error());
    char boot_id[32];
    snprintf(boot_id,sizeof(boot_id),"%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random());
    control_service_init(boot_id,record_dispatch,NULL,monotonic_ms);
    const int leds[2]={CONFIG_HEADLESS_LED1_GPIO,CONFIG_HEADLESS_LED2_GPIO};
    for(int i=0;i<2;i++)if(leds[i]>=0) {
        gpio_reset_pin(leds[i]);ESP_ERROR_CHECK(gpio_set_direction(leds[i],GPIO_MODE_OUTPUT));gpio_set_level(leds[i],0);
    }
    gpio_config_t btn={.pin_bit_mask=1ULL<<CONFIG_HEADLESS_BUTTON_GPIO,.mode=GPIO_MODE_INPUT,.pull_up_en=GPIO_PULLUP_ENABLE,.intr_type=GPIO_INTR_DISABLE};
    ESP_ERROR_CHECK(gpio_config(&btn));
    data_init();
    if(!is_data_layer_initialized()) { ESP_LOGE(TAG,"Data layer initialization failed");return; }
    data_register_status_update_callback(status_received);
    data_register_new_status_update_callback(new_status_received);
    if(connect_logic_ble_init()!=0) { ESP_LOGE(TAG,"BLE initialization failed");return; }
    if(xTaskCreate(connection_worker,"camera_connect",6144,NULL,3,NULL)!=pdPASS) { ESP_LOGE(TAG,"Connection worker creation failed");return; }
    setvbuf(stdin,NULL,_IONBF,0);
    (void)fcntl(STDIN_FILENO,F_SETFL,O_NONBLOCK);
    /* Raw LF makes exported JSONL byte counts identical to Flash bytes. */
    (void)uart_vfs_dev_port_set_tx_line_endings(CONFIG_ESP_CONSOLE_UART_NUM,ESP_LINE_ENDINGS_LF);
    console_command("help");
    char line[768];size_t used=0;bool overflow=false;
    for(;;) {
        receive_discovery();
        update_feedback();
        cap_sample_t phone_samples[2];snapshot(phone_samples);
        phone_service_poll(phone_samples,monotonic_ms());
        int ch;
        while((ch=getchar())!=EOF) {
            if(ch=='\r' || ch=='\n') {
                if(!overflow && used) { line[used]='\0';console_command(line); }
                if(overflow)ESP_LOGW(TAG,"Command too long; discarded");
                used=0;overflow=false;
            } else if(ch==8 || ch==127) { if(used)used--; }
            else if(ch>=32 && ch<127) { if(used<sizeof(line)-1)line[used++]=(char)ch;else overflow=true; }
        }
        clearerr(stdin);
        if(dc_button_update(&button,gpio_get_level(CONFIG_HEADLESS_BUTTON_GPIO)==0,now_ms()))recording_button();
        update_feedback();
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
