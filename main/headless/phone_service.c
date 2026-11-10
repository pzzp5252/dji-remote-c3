#include "phone_service.h"
#include "phone_gatt.h"
#include "control_service.h"
#include "journal.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

typedef struct { uint32_t session; uint16_t id; } destination_t;
static journal_reader_t reader;
static destination_t log_destination;
static enum { LOG_IDLE, LOG_BEGIN, LOG_READ, LOG_END } log_stage;
static uint32_t sent_lines;
static size_t sent_bytes;
static char log_error[160];
static uint32_t status_session;
static uint64_t status_time;
static char log_line[JOURNAL_LINE_MAX+1];

static void cancel_log(void) {
    journal_reader_close(&reader);
    log_stage=LOG_IDLE;
    memset(&log_destination,0,sizeof(log_destination));
}
static bool send_json(destination_t destination,uint8_t kind,cJSON *object) {
    char *json=object?cJSON_PrintUnformatted(object):NULL;
    const char *body=json?json:"{\"ok\":false,\"error\":\"out_of_memory\"}";
    bool ok=phone_gatt_send(destination.session,destination.id,kind,body,strlen(body));
    cJSON_free(json);cJSON_Delete(object);
    if(!ok)phone_gatt_drop(destination.session);
    return ok;
}
static void reply_bytes(void *ctx,const char *json,size_t length) {
    const destination_t *destination=ctx;
    if(!phone_gatt_send(destination->session,destination->id,PHONE_KIND_REPLY,json,length))
        phone_gatt_drop(destination->session);
}
static void error_reply(destination_t destination,const char *error) {
    cJSON *o=cJSON_CreateObject();
    if(o) { cJSON_AddBoolToObject(o,"ok",false);cJSON_AddStringToObject(o,"error",error); }
    (void)send_json(destination,PHONE_KIND_REPLY,o);
}
static cJSON *snapshot_info(void) {
    const journal_state_t *j=&reader.snapshot;
    cJSON *o=cJSON_CreateObject();if(!o)return NULL;
    bool ok=cJSON_AddStringToObject(o,"project_id",j->project_id) &&
        cJSON_AddStringToObject(o,"template_id",j->template_id) &&
        cJSON_AddNumberToObject(o,"event_seq",j->event_seq) &&
        cJSON_AddNumberToObject(o,"take_id",j->take_id) &&
        cJSON_AddNumberToObject(o,"lines",j->lines) &&
        cJSON_AddNumberToObject(o,"bytes",(double)j->bytes);
    if(!ok) { cJSON_Delete(o);return NULL; }return o;
}
static void begin_log(const cJSON *command,destination_t destination) {
    if(log_stage!=LOG_IDLE) { error_reply(destination,"log_busy");return; }
    const cJSON *project=cJSON_GetObjectItemCaseSensitive(command,"project_id");
    const cJSON *after=cJSON_GetObjectItemCaseSensitive(command,"after_seq");
    if(!cJSON_IsString(project) || strcmp(project->valuestring,journal_state()->project_id)) {
        error_reply(destination,"project_mismatch");return;
    }
    if(!cJSON_IsNumber(after) || !isfinite(after->valuedouble) || after->valuedouble<0 ||
       after->valuedouble>UINT32_MAX || floor(after->valuedouble)!=after->valuedouble ||
       after->valuedouble>journal_state()->event_seq) {
        error_reply(destination,"invalid_cursor");return;
    }
    if(!journal_reader_open(&reader,(uint32_t)after->valuedouble)) {
        error_reply(destination,journal_error());return;
    }
    log_destination=destination;sent_lines=0;sent_bytes=0;log_error[0]='\0';log_stage=LOG_BEGIN;
}
static void stream_step(void) {
    if(log_stage==LOG_IDLE || !phone_gatt_tx_idle(log_destination.session))return;
    if(log_stage==LOG_BEGIN) {
        cJSON *o=snapshot_info();
        if(!o || !cJSON_AddBoolToObject(o,"ok",true) ||
           !cJSON_AddNumberToObject(o,"after_seq",reader.after_seq)) {
            cJSON_Delete(o);snprintf(log_error,sizeof(log_error),"out_of_memory");log_stage=LOG_END;return;
        }
        if(send_json(log_destination,PHONE_KIND_LOG_BEGIN,o))log_stage=LOG_READ;
        else cancel_log();
        return;
    }
    if(strcmp(reader.snapshot.project_id,journal_state()->project_id) ||
       journal_state()->event_seq<reader.snapshot.event_seq) {
        snprintf(log_error,sizeof(log_error),"project_changed");log_stage=LOG_END;
    }
    if(log_stage==LOG_READ) {
        /* Skip at most eight bounded rows; BOOT/USB/STOP get another turn even
         * when a phone resumes near the end of a large project. */
        for(unsigned i=0;i<8;i++) {
            size_t length=0;
            journal_read_result_t result=journal_reader_next(&reader,log_line,&length);
            if(result==JOURNAL_READ_SKIP)continue;
            if(result==JOURNAL_READ_ERROR) {
                snprintf(log_error,sizeof(log_error),"%s",journal_error());log_stage=LOG_END;return;
            }
            if(result==JOURNAL_READ_END) { log_stage=LOG_END;return; }
            if(!phone_gatt_send(log_destination.session,log_destination.id,PHONE_KIND_LOG_EVENT,log_line,length-1)) {
                phone_gatt_drop(log_destination.session);cancel_log();return;
            }
            sent_lines++;sent_bytes+=length;
            return;
        }
        return;
    }
    cJSON *o=snapshot_info();
    if(o) {
        cJSON_AddBoolToObject(o,"ok",!log_error[0]);
        cJSON_AddNumberToObject(o,"through_seq",reader.snapshot.event_seq);
        cJSON_AddNumberToObject(o,"sent_lines",sent_lines);
        cJSON_AddNumberToObject(o,"sent_bytes",(double)sent_bytes);
        if(log_error[0])cJSON_AddStringToObject(o,"error",log_error);
    }
    (void)send_json(log_destination,PHONE_KIND_LOG_END,o);
    cancel_log();
}
void phone_service_poll(const cap_sample_t cameras[2],uint64_t now) {
    phone_gatt_poll(now);
    uint32_t session=phone_gatt_session();
    if(log_stage!=LOG_IDLE && session!=log_destination.session)cancel_log();
    if(!session) { status_session=0;return; }
    phone_request_t request;
    if(phone_gatt_can_send(session) && phone_gatt_take_request(&request)) {
        /* Generation check occurs just before dispatch, not only on dequeue. */
        if(request.session==session && request.session==phone_gatt_session()) {
            const char *end=NULL;
            cJSON *command=cJSON_ParseWithOpts(request.json,&end,true);
            const cJSON *name=command?cJSON_GetObjectItemCaseSensitive(command,"cmd"):NULL;
            destination_t destination={.session=request.session,.id=request.id};
            if(cJSON_IsObject(command) && cJSON_IsString(name) && !strcmp(name->valuestring,"GET_LOG")) {
                begin_log(command,destination);
            } else {
                control_request_t origin={.transport=CONTROL_BLE,.reply=reply_bytes,.ctx=&destination};
                if(request.session==phone_gatt_session())
                    control_service_command(command,cameras,now,&origin);
            }
            cJSON_Delete(command);
        }
    }
    session=phone_gatt_session();
    if(!session) { cancel_log();status_session=0;return; }
    if(log_stage!=LOG_IDLE) { stream_step();return; }
    if(phone_gatt_tx_idle(session) &&
       (status_session!=session || now<status_time || now-status_time>=1000)) {
        destination_t destination={.session=session,.id=0};
        if(send_json(destination,PHONE_KIND_STATUS,control_service_status(cameras,now))) {
            status_session=session;status_time=now;
        }
    }
}
