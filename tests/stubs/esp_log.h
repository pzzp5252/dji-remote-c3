#ifndef TEST_ESP_LOG_H
#define TEST_ESP_LOG_H
static inline void host_log(const char *tag,const char *fmt,...) { (void)tag;(void)fmt; }
#define ESP_LOGI(...) host_log(__VA_ARGS__)
#define ESP_LOGW(...) host_log(__VA_ARGS__)
#define ESP_LOGE(...) host_log(__VA_ARGS__)
#define ESP_LOGD(...) host_log(__VA_ARGS__)
#endif
