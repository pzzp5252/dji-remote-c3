#ifndef ESP_PLATFORM
#define _POSIX_C_SOURCE 200809L
#endif
#include "control_service.h"
#include "journal.h"
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

static capture_t take;
static char boot[CAP_ID_MAX];
static uint64_t event_now, anchor_mono, anchor_utc;
static uint32_t local_command;
static bool anchor_valid, external_seen[2];
static cap_dispatch_fn sender;
static void *sender_ctx;
static uint64_t (*clock_now)(void);

static const char *text(const cJSON *o, const char *key) {
    const cJSON *v=cJSON_GetObjectItemCaseSensitive(o,key);
    return cJSON_IsString(v)?v->valuestring:NULL;
}
static bool number(const cJSON *o,const char *key,uint64_t max,uint64_t *out) {
    const cJSON *v=cJSON_GetObjectItemCaseSensitive(o,key);
    if(!cJSON_IsNumber(v) || !isfinite(v->valuedouble) || v->valuedouble<0 ||
       v->valuedouble>(double)max || floor(v->valuedouble)!=v->valuedouble)return false;
    *out=(uint64_t)v->valuedouble;return true;
}
static void reply(cJSON *o,const control_request_t *request) {
    char *s=o?cJSON_PrintUnformatted(o):NULL;
    const char *json=s?s:"{\"ok\":false,\"error\":\"out_of_memory\"}";
    if(request && request->reply)request->reply(request->ctx,json,strlen(json));
    else puts(json);
    cJSON_free(s);cJSON_Delete(o);
}
static void ack(bool ok,const char *error,const control_request_t *request) {
    cJSON *o=cJSON_CreateObject();
    if(o) {
        cJSON_AddBoolToObject(o,"ok",ok);
        cJSON_AddNumberToObject(o,"take_id",journal_state()->take_id);
        cJSON_AddStringToObject(o,"project_id",journal_state()->project_id);
        cJSON_AddStringToObject(o,"template_id",journal_state()->template_id);
        cJSON_AddStringToObject(o,"action_id",journal_state()->action_id);
        cJSON_AddStringToObject(o,"point_id",journal_state()->point_id);
        cJSON_AddNumberToObject(o,"event_seq",journal_state()->event_seq);
        if(error)cJSON_AddStringToObject(o,"error",error);
    }
    reply(o,request);
}
static cJSON *event(const char *type) {
    cJSON *o=cJSON_CreateObject(), *a=anchor_valid?cJSON_CreateObject():cJSON_CreateNull();
    if(!o || !a) { cJSON_Delete(o);cJSON_Delete(a);return NULL; }
    bool ok=cJSON_AddStringToObject(o,"type",type) && cJSON_AddStringToObject(o,"boot_id",boot) &&
        cJSON_AddNumberToObject(o,"mono_ms",(double)event_now);
    if(anchor_valid)ok=ok && cJSON_AddStringToObject(a,"boot_id",boot) &&
        cJSON_AddNumberToObject(a,"mono_ms",(double)anchor_mono) &&
        cJSON_AddNumberToObject(a,"utc_ms",(double)anchor_utc);
    if(!cJSON_AddItemToObject(o,"time_anchor",a)) { cJSON_Delete(a);ok=false; }
    if(!ok) { cJSON_Delete(o);return NULL; }
    return o;
}
static bool append(cJSON *o) {
    bool ok=o && journal_append(o);
    cJSON_Delete(o);return ok;
}
static cJSON *evidence(const cap_evidence_t *e) {
    cJSON *o=cJSON_CreateObject();if(!o)return NULL;
    bool ok=true;
#define B(k) ok=(cJSON_AddBoolToObject(o,#k,e->k)!=NULL)&&ok
#define N(k) ok=(cJSON_AddNumberToObject(o,#k,(double)e->k)!=NULL)&&ok
#define T(k,present) ok=((present?cJSON_AddNumberToObject(o,#k,(double)e->k):cJSON_AddNullToObject(o,#k))!=NULL)&&ok
    B(participating);B(start_sent);B(start_failed);B(stop_sent);B(stop_failed);
    B(seen_recording);B(stop_confirmed);B(disconnected);B(reconnected);B(stale);
    B(unexpected_stop);B(restarted);B(unknown);B(final_connected);B(final_recording);
    N(disconnect_count);N(reconnect_count);N(record_time);N(battery);
    T(start_ms,e->start_sent || e->start_failed);
    T(stop_ms,e->stop_sent || (e->stop_failed && e->stop_ms!=0));
    T(first_record_ms,e->seen_recording);T(last_record_ms,e->seen_recording);
    T(stopped_ms,e->stop_confirmed);T(last_sample_ms,e->last_sample_ms!=0);
#undef B
#undef N
#undef T
    if(!ok) { cJSON_Delete(o);return NULL; }return o;
}
static bool emit(void *ctx,const char *type,const capture_t *t) {
    (void)ctx;
    cJSON *o=event(type);if(!o)return false;
    if(!strcmp(type,"TAKE_END")) {
        cJSON *time=cJSON_GetObjectItemCaseSensitive(o,"mono_ms");
        cJSON_SetNumberValue(time,(double)t->close_ms);
    }
    bool ok=cJSON_AddNumberToObject(o,"take_id",t->take_id) &&
        cJSON_AddStringToObject(o,"action_id",t->action_id) && cJSON_AddStringToObject(o,"point_id",t->point_id);
    if(!strcmp(type,"TAKE_BEGIN")) {
        ok=ok && cJSON_AddStringToObject(o,"command_id",t->command_id) &&
            cJSON_AddStringToObject(o,"source",t->source) && cJSON_AddNumberToObject(o,"participants",t->participants);
    } else {
        ok=ok && cJSON_AddStringToObject(o,"begin_boot_id",t->boot_id) &&
            cJSON_AddNumberToObject(o,"begin_mono_ms",(double)t->begin_ms) &&
            cJSON_AddStringToObject(o,"reason",t->reason) && cJSON_AddBoolToObject(o,"complete",t->complete) &&
            cJSON_AddBoolToObject(o,"observation_lost",t->observation_lost);
        cJSON *a=cJSON_AddArrayToObject(o,"cameras");
        if(!a)ok=false;
        for(int i=0;i<2 && a;i++) {
            cJSON *e=evidence(&t->cameras[i]);
            if(!e)ok=false;
            else if(!cJSON_AddItemToArray(a,e)) { cJSON_Delete(e);ok=false; }
        }
    }
    if(!ok) { cJSON_Delete(o);return false; }
    return append(o);
}
static bool dispatch(void *ctx,int slot,bool start) {
    (void)ctx;
    if(take.phase!=CAP_CLOSING) {
        uint64_t timestamp=clock_now?clock_now():event_now;
        if(start)take.cameras[slot].start_ms=timestamp;
        else take.cameras[slot].stop_ms=timestamp;
    }
    return sender && sender(sender_ctx,slot,start);
}
static void command_id(char id[CAP_ID_MAX]) {
    snprintf(id,CAP_ID_MAX,"%.40s-%" PRIu32,boot,++local_command);
}
static bool begin(const cap_sample_t s[2],const char *id,const char *source) {
    const journal_state_t *j=journal_state();
    if(!j->project_id[0] || j->unfinished || j->take_id==UINT32_MAX)return false;
    bool external=!strcmp(source,"external");
    if(!external && !j->action_id[0])return false;
    return capture_begin(&take,s,event_now,j->take_id+1,id,external?"":j->action_id,
                         external?"":j->point_id,boot,source);
}
void control_service_init(const char *boot_id,cap_dispatch_fn send,void *ctx,
                          uint64_t (*clock_ms)(void)) {
    sender=send;sender_ctx=ctx;clock_now=clock_ms;
    snprintf(boot,sizeof(boot),"%s",boot_id);
    event_now=clock_now?clock_now():0;local_command=0;anchor_valid=false;
    memset(external_seen,0,sizeof(external_seen));
    capture_init(&take,emit,dispatch,NULL);
    const journal_state_t *j=journal_state();
    if(j->unfinished && j->last_begin) {
        const cJSON *b=j->last_begin;
        take.take_id=j->take_id;take.recovered=true;take.complete=false;
        take.close_ms=event_now;
        snprintf(take.action_id,sizeof(take.action_id),"%s",text(b,"action_id"));
        snprintf(take.point_id,sizeof(take.point_id),"%s",text(b,"point_id"));
        snprintf(take.boot_id,sizeof(take.boot_id),"%s",text(b,"boot_id"));
        snprintf(take.reason,sizeof(take.reason),"power_loss");
        take.begin_ms=(uint64_t)cJSON_GetObjectItemCaseSensitive(b,"mono_ms")->valuedouble;
        take.participants=(uint8_t)cJSON_GetObjectItemCaseSensitive(b,"participants")->valueint;
        for(int i=0;i<2;i++) {
            take.cameras[i].participating=(take.participants&(1u<<i))!=0;
            take.cameras[i].unknown=true;
        }
        take.phase=CAP_CLOSING;
        if(emit(NULL,"TAKE_END",&take))take.phase=CAP_IDLE;
    }
}
void control_service_observation_lost(void) { if(capture_active(&take))take.observation_lost=true; }
void control_service_observe(const cap_sample_t s[2],uint64_t now) {
    event_now=now;
    capture_observe(&take,s,now);
    bool external=false;
    for(int i=0;i<2;i++) {
        bool recording=s[i].connected && capture_fresh(&s[i],now) && s[i].recording;
        if(recording && !external_seen[i])external=true;
        /* Disconnection/stale status is not proof of stopped or a new clip. */
        if(recording)external_seen[i]=true;
        else if(s[i].connected && capture_fresh(&s[i],now))external_seen[i]=false;
    }
    if(external && !capture_active(&take)) {
        char id[CAP_ID_MAX];command_id(id);
        (void)begin(s,id,"external");
    }
}
void control_service_button(const cap_sample_t s[2],uint64_t now) {
    event_now=now;
    if(capture_active(&take)) { (void)capture_stop(&take,s,now);return; }
    bool recording=false;
    for(int i=0;i<2;i++)recording|=s[i].connected && s[i].recording;
    char id[CAP_ID_MAX];command_id(id);
    if(recording) {
        if(begin(s,id,"external"))(void)capture_stop(&take,s,now);
        else for(int i=0;i<2;i++)if(s[i].connected)(void)dispatch(NULL,i,false);
    } else if(!begin(s,id,"boot"))ack(false,"start_rejected_or_storage_full",NULL);
}
bool control_service_active(void) { return capture_active(&take); }
int control_service_led(int slot,const cap_sample_t *s,uint64_t now) {
    return capture_led(&take,slot,s,now);
}
static cJSON *info(void) {
    const journal_state_t *j=journal_state();
    cJSON *o=cJSON_CreateObject();if(!o)return NULL;
    cJSON_AddBoolToObject(o,"ok",true);
    cJSON_AddStringToObject(o,"project_id",j->project_id);cJSON_AddStringToObject(o,"template_id",j->template_id);
    cJSON_AddStringToObject(o,"action_id",j->action_id);cJSON_AddStringToObject(o,"point_id",j->point_id);
    cJSON_AddNumberToObject(o,"event_seq",j->event_seq);cJSON_AddNumberToObject(o,"take_id",j->take_id);
    cJSON_AddNumberToObject(o,"lines",j->lines);cJSON_AddNumberToObject(o,"bytes",(double)j->bytes);
    cJSON_AddBoolToObject(o,"writable",j->writable);return o;
}
cJSON *control_service_status(const cap_sample_t s[2],uint64_t now) {
    cJSON *o=info();if(!o)return NULL;
    static const char *phases[]={"idle","starting","recording","stopping","closing"};
    cJSON_AddStringToObject(o,"phase",phases[take.phase]);
    cJSON_AddStringToObject(o,"boot_id",boot);
    cJSON_AddNumberToObject(o,"mono_ms",(double)now);
    cJSON_AddNumberToObject(o,"active_take_id",capture_active(&take)?take.take_id:0);
    cJSON_AddBoolToObject(o,"time_synced",anchor_valid);
    cJSON_AddStringToObject(o,"storage_error",journal_error());
    size_t total=0,used=0;
    if(journal_space(&total,&used) && used<=total)cJSON_AddNumberToObject(o,"free_bytes",(double)(total-used));
    cJSON *a=cJSON_AddArrayToObject(o,"cameras");
    for(int i=0;i<2 && a;i++) {
        cJSON *v=cJSON_CreateObject();if(!v) { cJSON_Delete(o);return NULL; }
        bool fresh=capture_fresh(&s[i],now);
        cJSON_AddBoolToObject(v,"connected",s[i].connected);cJSON_AddBoolToObject(v,"fresh",fresh);
        cJSON_AddBoolToObject(v,"recording",s[i].recording);cJSON_AddNumberToObject(v,"record_time",s[i].record_time);
        cJSON_AddNumberToObject(v,"battery",s[i].battery);cJSON_AddNumberToObject(v,"led",control_service_led(i,&s[i],now));
        cJSON_AddBoolToObject(v,"video",s[i].video);cJSON_AddBoolToObject(v,"sleeping",s[i].sleeping);
        if(s[i].valid && now>=s[i].status_ms)cJSON_AddNumberToObject(v,"status_age_ms",(double)(now-s[i].status_ms));
        else cJSON_AddNullToObject(v,"status_age_ms");
        cJSON_AddBoolToObject(v,"ready",fresh && s[i].video && !s[i].sleeping && !s[i].recording);
        cJSON_AddItemToArray(a,v);
    }
    return o;
}
static bool camera_safe(const cap_sample_t s[2],uint64_t now) {
    if(capture_active(&take))return false;
    for(int i=0;i<2;i++)if(s[i].connected && (!capture_fresh(&s[i],now) || s[i].recording))return false;
    return true;
}
void control_service_command(const cJSON *r,const cap_sample_t s[2],uint64_t now,
                             const control_request_t *request) {
    event_now=now;
    if(!cJSON_IsObject(r)) { ack(false,"invalid_json",request);return; }
    const char *cmd=text(r,"cmd");
    const journal_state_t *j=journal_state();
    bool ok=false;const char *error="invalid_request";
    if(!cmd)goto done;
    if(!request || (request->transport!=CONTROL_USB && request->transport!=CONTROL_BLE)) {
        error="invalid_transport";goto done;
    }
    if(request->transport!=CONTROL_USB &&
       (!strcmp(cmd,"RESET_PROJECT") || !strcmp(cmd,"EXPORT_LOG"))) {
        error="usb_only";goto done;
    }
    if(request->transport==CONTROL_BLE && !strcmp(cmd,"GET_LOG")) {
        error="stream_transport_required";goto done;
    }
    if(!strcmp(cmd,"GET_STATUS") || !strcmp(cmd,"GET_LOG_INFO")) {
        reply(!strcmp(cmd,"GET_STATUS")?control_service_status(s,now):info(),request);
        return;
    }
    if(!strcmp(cmd,"INIT_PROJECT")) {
        if(!camera_safe(s,now)) { error="camera_or_take_busy";goto done; }
        const char *project=text(r,"project_id"),*tmpl=text(r,"template_id");
        if(!project || !tmpl)goto done;
        ok=journal_init_project(project,tmpl);error=ok?NULL:journal_error();
    } else if(!strcmp(cmd,"TIME_SYNC")) {
        uint64_t utc;
        if(!number(r,"utc_ms",9007199254740991ULL,&utc))goto done;
        anchor_mono=now;anchor_utc=utc;anchor_valid=true;ok=true;
    } else if(!strcmp(cmd,"START")) {
        const char *id=text(r,"command_id");
        if(!journal_id_valid(id,CAP_ID_MAX,false))goto done;
        const char *project=text(r,"project_id");
        if(!project || strcmp(project,j->project_id)) { error="project_mismatch";goto done; }
        /* O(1): only the latest committed BEGIN is compared, including replay. */
        if(j->take_id && !strcmp(id,j->last_command_id)) { ok=true;goto done; }
        ok=begin(s,id,request->transport==CONTROL_BLE?"ble":"usb");error=ok?NULL:"start_rejected_or_storage_full";
    } else if(!strcmp(cmd,"STOP")) {
        uint64_t id;const char *project=text(r,"project_id");
        if(!project || strcmp(project,j->project_id) || !number(r,"take_id",UINT32_MAX,&id) || id!=j->take_id) {
            error="take_identity_mismatch";goto done;
        }
        ok=capture_active(&take)?capture_stop(&take,s,now):!j->unfinished;
        error=ok?NULL:"stop_rejected";
    } else if(!strcmp(cmd,"SELECT_ACTION") || !strcmp(cmd,"MARK_DISCARD") || !strcmp(cmd,"REASSIGN")) {
        if(capture_active(&take) || j->unfinished) { error="take_active";goto done; }
        const char *project=text(r,"project_id");
        if(!project || strcmp(project,j->project_id)) { error="project_mismatch";goto done; }
        cJSON *o=event(cmd);if(!o)goto done;
        bool valid=true;
        if(strcmp(cmd,"SELECT_ACTION")) {
            uint64_t id;
            valid=number(r,"take_id",UINT32_MAX,&id) && id>0 && id<=j->take_id;
            if(valid)valid=cJSON_AddNumberToObject(o,"take_id",(double)id)!=NULL;
        }
        if(!strcmp(cmd,"MARK_DISCARD")) {
            const cJSON *v=cJSON_GetObjectItemCaseSensitive(r,"discard");
            valid=valid && cJSON_IsBool(v) && cJSON_AddBoolToObject(o,"discard",cJSON_IsTrue(v));
        } else {
            const char *action=text(r,"action_id"),*point=text(r,"point_id");
            if(!point)point="";
            valid=valid && journal_id_valid(action,CAP_ACTION_MAX,false) && journal_id_valid(point,CAP_ACTION_MAX,true);
            if(valid)valid=cJSON_AddStringToObject(o,"action_id",action) && cJSON_AddStringToObject(o,"point_id",point);
        }
        if(valid)ok=append(o);else cJSON_Delete(o);
        error=ok?NULL:(valid?journal_error():"invalid_request");
    } else if(!strcmp(cmd,"EXPORT_LOG") || !strcmp(cmd,"GET_LOG")) {
        if(capture_active(&take)) { error="export_requires_closed_take";goto done; }
        uint64_t after=0;
        if(!strcmp(cmd,"GET_LOG") && !number(r,"after_seq",UINT32_MAX,&after))goto done;
        /* Keep other tasks' stdio diagnostics outside the JSONL frame. */
        flockfile(stdout);
        cJSON *o=info();if(o)cJSON_AddStringToObject(o,"frame","LOG_BEGIN");reply(o,request);
        ok=journal_export(stdout,(uint32_t)after);
        o=cJSON_CreateObject();if(o) {
            cJSON_AddStringToObject(o,"frame","LOG_END");cJSON_AddBoolToObject(o,"ok",ok);
            cJSON_AddNumberToObject(o,"event_seq",j->event_seq);
        }
        reply(o,request);fflush(stdout);funlockfile(stdout);return;
    } else if(!strcmp(cmd,"RESET_PROJECT")) {
        uint64_t seq,id,lines,bytes;
        const char *project=text(r,"project_id");
        if(!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(r,"confirm"))) { error="confirmation_required";goto done; }
        if(!camera_safe(s,now) || j->unfinished) { error="camera_or_take_busy";goto done; }
        if(!project || !number(r,"event_seq",UINT32_MAX,&seq) || !number(r,"take_id",UINT32_MAX,&id) ||
           !number(r,"lines",UINT32_MAX,&lines) || !number(r,"bytes",SIZE_MAX<9007199254740991ULL?SIZE_MAX:9007199254740991ULL,&bytes))goto done;
        ok=journal_reset(project,(uint32_t)seq,(uint32_t)id,(uint32_t)lines,(size_t)bytes);
        error=ok?NULL:journal_error();
    } else error="unknown_command";
done:
    ack(ok,ok?NULL:error,request);
}
