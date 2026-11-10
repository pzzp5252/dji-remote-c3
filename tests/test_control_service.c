#define _POSIX_C_SOURCE 200809L
#include "control_service.h"
#include "journal.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dirent.h>

static unsigned starts,stops;
static bool send_record(void *ctx,int slot,bool start) {
    (void)ctx;
    assert(slot==0); /* B is intentionally unavailable throughout this project. */
    assert(journal_state()->unfinished); /* No command before durable BEGIN. */
    if(start)starts++;else stops++;
    return true;
}
static cap_sample_t cameras[2];
static void command(const char *json,uint64_t now) {
    cJSON *object=cJSON_Parse(json);
    const control_request_t origin={.transport=CONTROL_USB};
    control_service_command(object,cameras,now,&origin);
    cJSON_Delete(object);
}
int main(void) {
    char root[]="/tmp/dji-control-XXXXXX";
    assert(mkdtemp(root));assert(journal_open(root));
    control_service_init("BOOT1",send_record,NULL,NULL);
    cameras[0]=(cap_sample_t){.connected=true,.valid=true,.video=true,.status_ms=100};
    command("{\"cmd\":\"INIT_PROJECT\",\"project_id\":\"RUN_1\",\"template_id\":\"TEMPLATE_1\"}",100);
    assert(!strcmp(journal_state()->project_id,"RUN_1"));
    assert(!strcmp(journal_state()->template_id,"TEMPLATE_1"));
    command("{\"cmd\":\"SELECT_ACTION\",\"project_id\":\"RUN_1\",\"action_id\":\"D27\",\"point_id\":\"P01\"}",100);
    command("{\"cmd\":\"TIME_SYNC\",\"utc_ms\":1794220000000}",100);
    command("{\"cmd\":\"START\",\"project_id\":\"RUN_1\",\"command_id\":\"C1\"}",101);
    assert(starts==1 && journal_state()->take_id==1 && control_service_active());
    command("{\"cmd\":\"START\",\"project_id\":\"RUN_1\",\"command_id\":\"C1\"}",102);
    assert(starts==1 && journal_state()->take_id==1);
    command("{\"cmd\":\"STOP\",\"project_id\":\"OTHER_RUN\",\"take_id\":1}",103);
    command("{\"cmd\":\"STOP\",\"project_id\":\"RUN_1\",\"take_id\":2}",103);
    assert(stops==0 && control_service_active());
    command("{\"cmd\":\"STOP\",\"project_id\":\"RUN_1\",\"take_id\":1}",104);
    assert(stops==1); /* Cancellation while waiting for START. */
    cameras[0].status_ms=105;control_service_observe(cameras,105);
    assert(!control_service_active() && !journal_state()->unfinished);
    command("{\"cmd\":\"MARK_DISCARD\",\"project_id\":\"RUN_1\",\"take_id\":1,\"discard\":true}",106);
    command("{\"cmd\":\"REASSIGN\",\"project_id\":\"RUN_1\",\"take_id\":1,\"action_id\":\"S01\"}",107);
    assert(journal_state()->event_seq==5);
    assert(!strcmp(journal_state()->action_id,"D27")); /* REASSIGN is not selection. */
    command("{\"cmd\":\"START\",\"project_id\":\"RUN_1\",\"command_id\":\"C1\"}",108);
    assert(starts==1);
    command("{\"cmd\":\"START\",\"project_id\":\"RUN_1\",\"command_id\":\"C2\"}",109);
    assert(starts==2 && journal_state()->take_id==2);
    assert(journal_open(root)); /* Simulated power loss with BEGIN, without END. */
    control_service_init("BOOT2",send_record,NULL,NULL);
    assert(!journal_state()->unfinished && !control_service_active());
    assert(journal_state()->event_seq==7);
    assert(!strcmp(journal_state()->last_command_id,"C2"));
    command("{\"cmd\":\"START\",\"project_id\":\"RUN_1\",\"command_id\":\"C2\"}",110);
    assert(starts==2 && journal_state()->take_id==2);
    FILE *export=tmpfile();assert(export && journal_export(export,0));rewind(export);
    char line[JOURNAL_LINE_MAX];unsigned count=0;
    while(fgets(line,sizeof(line),export)) {
        cJSON *e=cJSON_Parse(line);assert(e);count++;
        if(count==2)assert(cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(e,"time_anchor")));
        if(count==7) {
            assert(!strcmp(cJSON_GetObjectItemCaseSensitive(e,"reason")->valuestring,"power_loss"));
            assert(!strcmp(cJSON_GetObjectItemCaseSensitive(e,"begin_boot_id")->valuestring,"BOOT1"));
            assert(!strcmp(cJSON_GetObjectItemCaseSensitive(e,"boot_id")->valuestring,"BOOT2"));
            assert(cJSON_IsNull(cJSON_GetObjectItemCaseSensitive(e,"time_anchor")));
            assert(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(e,"complete")));
        }
        cJSON_Delete(e);
    }
    assert(count==7);fclose(export);
    command("{\"cmd\":\"START\",\"project_id\":\"RUN_1\",\"command_id\":\"C3\"}",111);
    assert(starts==3 && journal_state()->take_id==3);
    command("{\"cmd\":\"STOP\",\"project_id\":\"RUN_1\",\"take_id\":2}",112);
    assert(stops==1); /* Delayed STOP cannot stop the next take. */
    cameras[0].recording=true;cameras[0].status_ms=113;
    cameras[1]=(cap_sample_t){.connected=true,.valid=true,.video=true,.recording=true,.status_ms=114};
    control_service_observe(cameras,114);
    cameras[1].connected=false;control_service_observe(cameras,115);
    command("{\"cmd\":\"STOP\",\"project_id\":\"RUN_1\",\"take_id\":3}",116);
    cameras[0].recording=false;cameras[0].status_ms=117;
    control_service_observe(cameras,117);
    cameras[0].status_ms=6116;control_service_observe(cameras,6116);
    assert(!control_service_active() && !journal_state()->unfinished);
    export=tmpfile();assert(export && journal_export(export,8));rewind(export);
    assert(fgets(line,sizeof(line),export));
    cJSON *ended=cJSON_Parse(line);assert(ended);
    const cJSON *b=cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(ended,"cameras"),1);
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(b,"unknown")));
    assert(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(b,"stop_confirmed")));
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(b,"stop_failed")));
    assert(cJSON_IsNull(cJSON_GetObjectItemCaseSensitive(b,"stop_ms")));
    assert(!strcmp(cJSON_GetObjectItemCaseSensitive(ended,"reason")->valuestring,"stop_timeout"));
    cJSON_Delete(ended);fclose(export);
    puts("control service: command identity, recovery and single-camera continuation passed");
    DIR *dir=opendir(root);assert(dir);
    struct dirent *entry;
    while((entry=readdir(dir))) {
        if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,".."))continue;
        char path[512];snprintf(path,sizeof(path),"%s/%s",root,entry->d_name);
        assert(unlink(path)==0);
    }
    closedir(dir);assert(rmdir(root)==0);
    return 0;
}
