#ifndef HEADLESS_PHONE_GATT_H
#define HEADLESS_PHONE_GATT_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#define PHONE_SERVICE_UUID "749d1000-7fbe-4dbf-9f6a-307ca69c6bc5"
#define PHONE_RX_UUID "749d1001-7fbe-4dbf-9f6a-307ca69c6bc5"
#define PHONE_TX_UUID "749d1002-7fbe-4dbf-9f6a-307ca69c6bc5"
#define PHONE_INFO_UUID "749d1003-7fbe-4dbf-9f6a-307ca69c6bc5"
#define PHONE_COMMAND_MAX 767u
#define PHONE_MESSAGE_MAX 4096u
#define PHONE_KIND_REPLY 1u
#define PHONE_KIND_STATUS 2u
#define PHONE_KIND_LOG_BEGIN 3u
#define PHONE_KIND_LOG_EVENT 4u
#define PHONE_KIND_LOG_END 5u
typedef struct { uint32_t session; uint16_t id; char json[PHONE_COMMAND_MAX+1]; } phone_request_t;
struct ble_gap_event;
/* Register services before starting NimBLE; on_sync enables advertising. */
esp_err_t phone_gatt_init(void);
void phone_gatt_on_sync(void);
void phone_gatt_on_reset(void);
/* True means phone-specific event consumed. Must leave camera events alone. */
bool phone_gatt_gap_event(struct ble_gap_event *event);
/* Nonblocking main-task pump. No filesystem/camera work on BLE host. */
void phone_gatt_poll(uint64_t now_ms);
uint32_t phone_gatt_session(void); /* zero unless connected and TX subscribed */
bool phone_gatt_take_request(phone_request_t *out);
bool phone_gatt_can_send(uint32_t session);
bool phone_gatt_tx_idle(uint32_t session);
bool phone_gatt_send(uint32_t session,uint16_t id,uint8_t kind,const char *json,size_t length);
void phone_gatt_drop(uint32_t session);
/* Camera wake uses the same legacy advertiser. Suspend phone advertising until
 * its short broadcast completes; do not cancel phone links or camera scans. */
void phone_gatt_suspend_advertising(bool suspended);
#endif
