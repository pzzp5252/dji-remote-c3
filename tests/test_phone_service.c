#define _POSIX_C_SOURCE 200809L
#include "phone_service.h"
#include "phone_gatt.h"
#include "control_service.h"
#include "journal.h"
#include <assert.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct { uint32_t session;uint16_t id;uint8_t kind;size_t length;char json[4097]; } message_t;
static uint32_t session=1;
static phone_request_t pending;
static bool request_pending,hold_tx,fail_send;
static unsigned starts,stops,drops,count;
static message_t messages[128];
static cap_sample_t cameras[2];
void phone_gatt_poll(uint64_t now) { (void)now; }
uint32_t phone_gatt_session(void) { return session; }
bool phone_gatt_take_request(phone_request_t *out) {
    if(!request_pending)return false;
    *out=pending;request_pending=false;return true;
}
bool phone_gatt_can_send(uint32_t generation) { return generation && generation==session; }
bool phone_gatt_tx_idle(uint32_t generation) { return phone_gatt_can_send(generation) && !hold_tx; }
bool phone_gatt_send(uint32_t generation,uint16_t id,uint8_t kind,const char *json,size_t length) {
    if(!phone_gatt_can_send(generation) || fail_send) { fail_send=false;return false; }
    assert(count<128 && length<=4096);
    message_t *m=&messages[count++];
    m->session=generation;m->id=id;m->kind=kind;m->length=length;
    memcpy(m->json,json,length);m->json[length]='\0';return true;
}
void phone_gatt_drop(uint32_t generation) { if(generation==session) { session=0;drops++; } }
static bool dispatch(void *ctx,int slot,bool start) {
    (void)ctx;assert(slot==0 || slot==1);assert(journal_state()->unfinished);
    if(start)starts++;else stops++;
    return true;
}
static void enqueue(uint32_t generation,uint16_t id,const char *json) {
    assert(!request_pending && strlen(json)<=PHONE_COMMAND_MAX);
    pending.session=generation;pending.id=id;strcpy(pending.json,json);request_pending=true;
}
static void poll(uint64_t now) { phone_service_poll(cameras,now); }
static cJSON *find_message(uint16_t id,uint8_t kind) {
    for(unsigned i=count;i>0;i--)if(messages[i-1].id==id && messages[i-1].kind==kind)
        return cJSON_Parse(messages[i-1].json);
    return NULL;
}
static cJSON *usb_reply;
static void capture_reply(void *ctx,const char *json,size_t length) {
    (void)ctx;(void)length;cJSON_Delete(usb_reply);usb_reply=cJSON_Parse(json);assert(usb_reply);
}
static void usb(const char *json,uint64_t now) {
    cJSON *command=cJSON_Parse(json);assert(command);
    const control_request_t origin={.transport=CONTROL_USB,.reply=capture_reply};
    control_service_command(command,cameras,now,&origin);cJSON_Delete(command);
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(usb_reply,"ok")));
}
static void expect_error(uint16_t id,const char *error) {
    cJSON *reply=find_message(id,PHONE_KIND_REPLY);assert(reply);
    assert(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(reply,"ok")));
    assert(!strcmp(cJSON_GetObjectItemCaseSensitive(reply,"error")->valuestring,error));cJSON_Delete(reply);
}
int main(void) {
    char root[]="/tmp/dji-phone-service-XXXXXX";assert(mkdtemp(root));assert(journal_open(root));
    control_service_init("PHONE_TEST_BOOT",dispatch,NULL,NULL);
    cameras[0]=cameras[1]=(cap_sample_t){.connected=true,.valid=true,.video=true,.status_ms=1000};
    usb("{\"cmd\":\"INIT_PROJECT\",\"project_id\":\"P\",\"template_id\":\"T\"}",1000);
    usb("{\"cmd\":\"SELECT_ACTION\",\"project_id\":\"P\",\"action_id\":\"S01\"}",1000);
    enqueue(1,1,"{\"cmd\":\"RESET_PROJECT\",\"project_id\":\"P\",\"event_seq\":1,\"take_id\":0,\"lines\":1,\"bytes\":0,\"confirm\":true}");poll(1000);
    expect_error(1,"usb_only");assert(journal_state()->event_seq==1);
    enqueue(1,2,"{\"cmd\":\"EXPORT_LOG\"}");poll(1000);expect_error(2,"usb_only");
    enqueue(1,3,"{\"cmd\":\"START\",\"project_id\":\"P\",\"command_id\":\"BLE_1\"}");poll(1001);
    assert(starts==2 && journal_state()->take_id==1 && control_service_active());
    assert(!strcmp(cJSON_GetObjectItemCaseSensitive(journal_state()->last_begin,"source")->valuestring,"ble"));
    enqueue(1,4,"{\"cmd\":\"START\",\"project_id\":\"P\",\"command_id\":\"BLE_1\"}");poll(1002);
    assert(starts==2 && journal_state()->event_seq==2);
    enqueue(1,7,"{\"cmd\":\"GET_LOG\",\"project_id\":\"P\",\"after_seq\":0}");poll(1003);
    cJSON *begin=find_message(7,PHONE_KIND_LOG_BEGIN);assert(begin);
    assert(cJSON_GetObjectItemCaseSensitive(begin,"event_seq")->valueint==2);cJSON_Delete(begin);
    hold_tx=true;
    enqueue(1,8,"{\"cmd\":\"STOP\",\"project_id\":\"P\",\"take_id\":1}");poll(1004);
    assert(stops==2 && control_service_active()); /* Slow log transport cannot delay STOP dispatch. */
    cJSON *stopped=find_message(8,PHONE_KIND_REPLY);assert(stopped);
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(stopped,"ok")));cJSON_Delete(stopped);
    cameras[0].status_ms=cameras[1].status_ms=1005;
    control_service_observe(cameras,1005);assert(!control_service_active() && journal_state()->event_seq==3);
    enqueue(1,9,"{\"cmd\":\"GET_LOG\",\"project_id\":\"P\",\"after_seq\":0}");poll(1006);expect_error(9,"log_busy");
    hold_tx=false;
    for(unsigned i=0;i<8;i++)poll(1010+i);
    cJSON *end=find_message(7,PHONE_KIND_LOG_END);assert(end);
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(end,"ok")));
    assert(cJSON_GetObjectItemCaseSensitive(end,"through_seq")->valueint==2);
    assert(cJSON_GetObjectItemCaseSensitive(end,"sent_lines")->valueint==2);
    size_t streamed=0;unsigned events=0;
    for(unsigned i=0;i<count;i++)if(messages[i].id==7 && messages[i].kind==PHONE_KIND_LOG_EVENT) {
        cJSON *event=cJSON_Parse(messages[i].json);assert(event);
        assert(strcmp(cJSON_GetObjectItemCaseSensitive(event,"type")->valuestring,"TAKE_END"));
        streamed+=messages[i].length+1;events++;cJSON_Delete(event);
    }
    assert(events==2 && (size_t)cJSON_GetObjectItemCaseSensitive(end,"sent_bytes")->valuedouble==streamed);cJSON_Delete(end);
    enqueue(1,10,"{\"cmd\":\"GET_LOG\",\"project_id\":\"P\",\"after_seq\":2}");poll(1020);
    for(unsigned i=0;i<8;i++)poll(1021+i);
    cJSON *event=find_message(10,PHONE_KIND_LOG_EVENT);assert(event);
    assert(!strcmp(cJSON_GetObjectItemCaseSensitive(event,"type")->valuestring,"TAKE_END"));cJSON_Delete(event);
    enqueue(1,11,"{\"cmd\":\"GET_LOG\",\"project_id\":\"WRONG\",\"after_seq\":0}");poll(1030);expect_error(11,"project_mismatch");
    enqueue(1,12,"{\"cmd\":\"GET_LOG\",\"project_id\":\"P\",\"after_seq\":4}");poll(1030);expect_error(12,"invalid_cursor");
    session=2;
    enqueue(1,13,"{\"cmd\":\"START\",\"project_id\":\"P\",\"command_id\":\"STALE\"}");poll(1031);
    assert(starts==2 && journal_state()->take_id==1);
    enqueue(2,14,"{\"cmd\":\"GET_LOG\",\"project_id\":\"P\",\"after_seq\":0}");poll(1032);
    session=3;poll(1033); /* Cancels the old reader on disconnect/reconnect. */
    enqueue(3,15,"{\"cmd\":\"GET_LOG\",\"project_id\":\"P\",\"after_seq\":3}");poll(1034);
    for(unsigned i=0;i<8;i++)poll(1035+i);
    end=find_message(15,PHONE_KIND_LOG_END);assert(end);
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(end,"ok")));
    assert(cJSON_GetObjectItemCaseSensitive(end,"sent_lines")->valueint==0);cJSON_Delete(end);
    enqueue(3,16,"{\"cmd\":\"GET_LOG\",\"project_id\":\"P\",\"after_seq\":0}");poll(1044);
    char reset[256];const journal_state_t *j=journal_state();
    snprintf(reset,sizeof(reset),"{\"cmd\":\"RESET_PROJECT\",\"project_id\":\"P\",\"event_seq\":%u,\"take_id\":%u,\"lines\":%u,\"bytes\":%zu,\"confirm\":true}",j->event_seq,j->take_id,j->lines,j->bytes);
    usb(reset,1045);poll(1046);
    end=find_message(16,PHONE_KIND_LOG_END);assert(end);
    assert(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(end,"ok")));
    assert(!strcmp(cJSON_GetObjectItemCaseSensitive(end,"error")->valuestring,"project_changed"));cJSON_Delete(end);
    fail_send=true;enqueue(3,17,"{\"cmd\":\"GET_STATUS\"}");poll(1047);assert(drops==1 && !session);
    poll(1048);cJSON_Delete(usb_reply);
    DIR *dir=opendir(root);assert(dir);struct dirent *entry;
    while((entry=readdir(dir))) {
        if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,".."))continue;
        char path[512];snprintf(path,sizeof(path),"%s/%s",root,entry->d_name);assert(unlink(path)==0);
    }
    closedir(dir);assert(rmdir(root)==0);
    puts("phone service: transport permissions, snapshot integrity, STOP responsiveness and session isolation passed");
    return 0;
}
