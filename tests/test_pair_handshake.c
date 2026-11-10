#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ui.h"
#include "command_logic.h"
#include "connect_logic.h"
#include "data.h"

camera_state_t g_camera_states[NUM_CAMERAS];
ui_state_t g_ui_state;
uint32_t test_handshake_ticks=100;
static int scenario,command_waits,ack_count,disconnects,initial_timeout,command_timeout;
static uint16_t ack_seq;
static uint8_t expected_verify_mode;
static int waits[4];
void headless_state_lock(void) {}
void headless_state_unlock(void) {}
const char *ui_get_camera_model_name(uint32_t id) { assert(id==0xFF55);return "Action 6"; }
uint16_t generate_seq(void) { return 1; }
esp_err_t ble_disconnect(int slot) { assert(slot==0);disconnects++;return ESP_OK; }
int subscript_camera_status(int slot,uint8_t mode,uint8_t freq) { assert(slot==0 && mode==3 && freq==20);return 0; }
CommandResult send_command(int slot,uint8_t set,uint8_t id,uint8_t type,const void *frame,uint16_t seq,int timeout) {
    assert(slot==0 && set==0 && id==0x19);
    if(type==ACK_NO_RESPONSE) {
        const connection_request_response_frame *ack=frame;
        assert(ack->device_id==0x12345678 && ack->ret_code==0);
        ack_count++;ack_seq=seq;return (CommandResult){0};
    }
    assert(type==CMD_WAIT_RESULT);
    const connection_request_command_frame *request=frame;
    assert(request->verify_mode==expected_verify_mode);
    initial_timeout=timeout;
    if(scenario==2 || scenario==6 || scenario==7 || (scenario==1 && timeout<15000))return (CommandResult){0};
    if(scenario==5) {
        connection_request_command_frame *request=calloc(1,sizeof(*request));assert(request);
        request->device_id=0xFF55;request->verify_mode=2;
        return (CommandResult){request,sizeof(*request)};
    }
    connection_request_response_frame *response=calloc(1,sizeof(*response));assert(response);
    return (CommandResult){response,sizeof(*response)};
}
esp_err_t data_wait_for_result_by_cmd(uint8_t set,uint8_t id,int timeout,uint16_t *seq,void **result,size_t *len) {
    assert(set==0 && id==0x19);assert(command_waits<4);waits[command_waits]=timeout;command_waits++;command_timeout=timeout;
    /* An incoming command is consumed once, just like the production data map. */
    if(command_waits>(scenario==7?3:scenario==6?2:1) || (scenario==1 && timeout<15000))return ESP_ERR_TIMEOUT;
    if((scenario==6 && command_waits==1) || (scenario==7 && command_waits<=2)) {
        if(scenario==7)test_handshake_ticks+=10000;
        connection_request_response_frame *ack=calloc(1,sizeof(*ack));assert(ack);
        *result=ack;*len=sizeof(*ack);*seq=1;return ESP_OK;
    }
    connection_request_command_frame *request=calloc(1,sizeof(*request));assert(request);
    request->device_id=0xFF55;request->verify_mode=2;request->verify_data=scenario==4?1:0;
    *result=request;*len=sizeof(*request);*seq=0xbeef;return ESP_OK;
}
int main(int argc,char **argv) {
    assert(argc==2);scenario=atoi(argv[1]);
    const int8_t mac[6]={1,2,3,4,5,6};
    expected_verify_mode=(scenario==3 || scenario==8 || scenario==9)?0:1;
    g_camera_states[0].is_paired=scenario==3 || scenario==9;
    int result=connect_logic_protocol_connect(0,0x12345678,6,mac,0,expected_verify_mode,0,0);
    if(scenario==4) { assert(result==-1 && ack_count==0 && disconnects==1); }
    else {
        assert(result==0);assert(command_waits==(scenario==5?0:scenario==7?3:scenario==6?2:1));assert(ack_count==1 && ack_seq==(scenario==5?1:0xbeef));assert(disconnects==0);
        assert(g_camera_states[0].device_id==0xFF55);
        if(scenario==1)assert(initial_timeout<=5000 && command_timeout>=60000);
        if(scenario==3)assert(initial_timeout<=5000 && command_timeout<=30000);
        if(scenario==7)assert(waits[0]==60000 && waits[1]==50000 && waits[2]==40000);
        if(scenario==8)assert(command_timeout==60000); /* Unknown history, mode 0 may ask a person. */
        if(scenario==9)assert(command_timeout==30000); /* Known history, mode 0 reconnect. */
    }
    printf("pair_handshake scenario %d passed\n",scenario);
}
