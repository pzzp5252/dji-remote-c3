#include "phone_gatt.h"
#include "phone_wire.h"
#include <string.h>
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "host/ble_att.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_hs_mbuf.h"
#include "host/ble_l2cap.h"
#include "host/ble_uuid.h"
#include "nimble/nimble_port.h"
#include "services/gap/ble_svc_gap.h"

#define PHONE_QUEUE_DEPTH 4u
#define PHONE_CONFIRM_TIMEOUT_MS 5000u

/* NimBLE UUID arrays are least-significant byte first. */
#define PHONE_UUID_BYTES(n) 0xc5, 0x6b, 0x9c, 0xa6, 0x7c, 0x30, 0x6a, 0x9f, \
                           0xbf, 0x4d, 0xbe, 0x7f, (n), 0x10, 0x9d, 0x74
static const ble_uuid128_t s_service_uuid = BLE_UUID128_INIT(PHONE_UUID_BYTES(0));
static const ble_uuid128_t s_rx_uuid = BLE_UUID128_INIT(PHONE_UUID_BYTES(1));
static const ble_uuid128_t s_tx_uuid = BLE_UUID128_INIT(PHONE_UUID_BYTES(2));
static const ble_uuid128_t s_info_uuid = BLE_UUID128_INIT(PHONE_UUID_BYTES(3));
static const char s_info[] =
    "{\"protocol\":1,\"header_bytes\":8,\"max_command_bytes\":767,"
    "\"max_message_bytes\":4096,\"default_packet_bytes\":20}";

_Static_assert(PHONE_COMMAND_MAX == PHONE_WIRE_COMMAND_MAX, "command bound");
_Static_assert(PHONE_MESSAGE_MAX == PHONE_WIRE_MESSAGE_MAX, "message bound");
_Static_assert(PHONE_KIND_REPLY == PHONE_WIRE_KIND_REPLY &&
               PHONE_KIND_STATUS == PHONE_WIRE_KIND_STATUS &&
               PHONE_KIND_LOG_BEGIN == PHONE_WIRE_KIND_LOG_BEGIN &&
               PHONE_KIND_LOG_EVENT == PHONE_WIRE_KIND_LOG_EVENT &&
               PHONE_KIND_LOG_END == PHONE_WIRE_KIND_LOG_END, "wire kinds");

typedef struct {
    uint32_t session;
    uint16_t id;
    uint16_t length;
    uint8_t kind;
    char json[PHONE_MESSAGE_MAX];
} phone_message_t;

static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
/* Only short advertiser API calls hold this mutex, never application work. */
static StaticSemaphore_t s_adv_mutex_storage;
static SemaphoreHandle_t s_adv_mutex;
static struct ble_npl_event s_work;
static bool s_initialized;
static bool s_synced;
static bool s_suspended;
static bool s_advertising;
static bool s_subscribed;
static bool s_closing;
static bool s_terminate_sent;
static uint32_t s_generation;
static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_mtu = 23;
static uint16_t s_tx_handle;
static phone_request_t s_in[PHONE_QUEUE_DEPTH];
static uint16_t s_in_lengths[PHONE_QUEUE_DEPTH];
static unsigned s_in_head, s_in_tail, s_in_count;
static phone_wire_assembler_t s_rx;
static phone_message_t s_out[PHONE_QUEUE_DEPTH];
static unsigned s_out_head, s_out_tail, s_out_count;
static uint16_t s_tx_offset;
static bool s_pending;
static uint16_t s_pending_bytes;
static uint64_t s_pending_since;

static uint64_t mono_ms(void) {
    return (uint64_t)esp_timer_get_time() / 1000u;
}

static void schedule_work(void) {
    if (s_initialized) {
        ble_npl_eventq_put(nimble_port_get_dflt_eventq(), &s_work);
    }
}

/* Caller holds s_lock. Do not clear/copy the large queue storage. */
static void invalidate_locked(void) {
    if (++s_generation == 0) {
        ++s_generation;
    }
    s_subscribed = false;
    s_in_head = s_in_tail = s_in_count = 0;
    s_out_head = s_out_tail = s_out_count = 0;
    s_rx.buffer = NULL;
    phone_wire_assembler_reset(&s_rx);
    s_tx_offset = 0;
    s_pending = false;
    s_pending_bytes = 0;
    s_pending_since = 0;
}

static bool usable_locked(uint32_t session) {
    return session && s_synced && s_conn != BLE_HS_CONN_HANDLE_NONE &&
           s_subscribed && !s_closing && session == s_generation;
}

static void close_locked(void) {
    invalidate_locked();
    s_closing = s_conn != BLE_HS_CONN_HANDLE_NONE;
    s_terminate_sent = false;
}

static int phone_gap_cb(struct ble_gap_event *event, void *arg) {
    (void)arg;
    phone_gatt_gap_event(event);
    return 0;
}

static void advertise(void) {
    xSemaphoreTake(s_adv_mutex, portMAX_DELAY);
    portENTER_CRITICAL(&s_lock);
    bool allowed = s_synced && !s_suspended && !s_advertising &&
                   s_conn == BLE_HS_CONN_HANDLE_NONE;
    portEXIT_CRITICAL(&s_lock);
    if (!allowed || ble_gap_adv_active()) {
        xSemaphoreGive(s_adv_mutex);
        return;
    }
    uint8_t own_addr_type;
    int rc = ble_hs_id_infer_auto(0, &own_addr_type);
    struct ble_hs_adv_fields fields = {
        .flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP,
        .uuids128 = &s_service_uuid,
        .num_uuids128 = 1,
        .uuids128_is_complete = 1,
    };
    const char *name = ble_svc_gap_device_name();
    size_t name_length = strlen(name);
    if (name_length > 29) {
        name_length = 29;
    }
    struct ble_hs_adv_fields scan_response = {
        .name = (const uint8_t *)name,
        .name_len = (uint8_t)name_length,
        .name_is_complete = strlen(name) == name_length,
    };
    if (!rc) {
        rc = ble_gap_adv_set_fields(&fields);
    }
    if (!rc) {
        rc = ble_gap_adv_rsp_set_fields(&scan_response);
    }
    struct ble_gap_adv_params params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
        .itvl_min = 0x100,
        .itvl_max = 0x180,
    };
    if (!rc) {
        rc = ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &params,
                               phone_gap_cb, NULL);
    }
    portENTER_CRITICAL(&s_lock);
    s_advertising = rc == 0;
    portEXIT_CRITICAL(&s_lock);
    xSemaphoreGive(s_adv_mutex);
}

/* All indication API calls run on the host queue, so a connection handle cannot
 * be recycled between the generation check and the actual send. */
static void host_work(struct ble_npl_event *event) {
    (void)event;
    portENTER_CRITICAL(&s_lock);
    bool synced = s_synced;
    bool terminate = synced && s_closing && !s_terminate_sent;
    uint16_t conn = s_conn;
    bool needs_advertising = s_conn == BLE_HS_CONN_HANDLE_NONE &&
                             !s_suspended && !s_advertising;
    if (terminate) {
        s_terminate_sent = true;
    }
    portEXIT_CRITICAL(&s_lock);
    if (!synced) {
        return;
    }
    if (terminate && conn != BLE_HS_CONN_HANDLE_NONE) {
        int rc = ble_gap_terminate(conn, BLE_ERR_REM_USER_CONN_TERM);
        if (rc) {
            portENTER_CRITICAL(&s_lock);
            if (s_conn == conn && s_closing) {
                s_terminate_sent = false;
            }
            portEXIT_CRITICAL(&s_lock);
        }
        return;
    }
    if (needs_advertising) {
        advertise();
    }

    uint8_t header[PHONE_WIRE_HEADER_BYTES];
    const char *payload = NULL;
    size_t length = 0;
    uint32_t session = 0;
    portENTER_CRITICAL(&s_lock);
    if (usable_locked(s_generation) && s_out_count && !s_pending) {
        phone_message_t *message = &s_out[s_out_head];
        if (message->session == s_generation) {
            size_t packet_bytes = (size_t)s_mtu - 3u;
            if(packet_bytes > 512u)packet_bytes = 512u;
            size_t limit = packet_bytes - PHONE_WIRE_HEADER_BYTES;
            length = message->length - s_tx_offset;
            if (length > limit) {
                length = limit;
            }
            if (phone_wire_header_encode(header, message->kind, message->id,
                                         s_tx_offset, message->length, length)) {
                conn = s_conn;
                session = s_generation;
                payload = message->json + s_tx_offset;
                s_pending = true;
                s_pending_bytes = (uint16_t)length;
                s_pending_since = mono_ms();
            }
        }
    }
    portEXIT_CRITICAL(&s_lock);
    if (!payload) {
        return;
    }
    /* Copy each payload byte only once, directly into the outgoing mbuf. */
    struct os_mbuf *om = ble_hs_mbuf_from_flat(header, sizeof(header));
    if (om && os_mbuf_append(om, payload, (uint16_t)length)) {
        os_mbuf_free_chain(om);
        om = NULL;
    }
    portENTER_CRITICAL(&s_lock);
    bool current = usable_locked(session) && s_conn == conn && s_pending;
    portEXIT_CRITICAL(&s_lock);
    if (!current) {
        os_mbuf_free_chain(om);
        return;
    }
    /* The API consumes om even on error. Status 0 is only "sent", not an ACK. */
    int rc = om ? ble_gatts_indicate_custom(conn, s_tx_handle, om) : BLE_HS_ENOMEM;
    if (rc) {
        portENTER_CRITICAL(&s_lock);
        if (usable_locked(session)) {
            close_locked();
        }
        portEXIT_CRITICAL(&s_lock);
        schedule_work();
    }
}

static int access_cb(uint16_t conn, uint16_t attr,
                     struct ble_gatt_access_ctxt *ctxt, void *arg) {
    (void)attr;
    if (arg == (void *)&s_info_uuid && ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        return os_mbuf_append(ctxt->om, s_info, sizeof(s_info) - 1) == 0
                   ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (arg != (void *)&s_rx_uuid || ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    /* ATT values are bounded by the maximum negotiated ATT MTU (517 minus 3). */
    uint8_t packet[514];
    size_t length = OS_MBUF_PKTLEN(ctxt->om);
    portENTER_CRITICAL(&s_lock);
    bool current = s_conn == conn && usable_locked(s_generation);
    if (!current) {
        portEXIT_CRITICAL(&s_lock);
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    if (length > sizeof(packet) || length > (size_t)s_mtu - 3u ||
        length <= PHONE_WIRE_HEADER_BYTES) {
        phone_wire_assembler_reset(&s_rx);
        portEXIT_CRITICAL(&s_lock);
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (s_in_count == PHONE_QUEUE_DEPTH) {
        portEXIT_CRITICAL(&s_lock);
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (os_mbuf_copydata(ctxt->om, 0, (int)length, packet)) {
        phone_wire_assembler_reset(&s_rx);
        portEXIT_CRITICAL(&s_lock);
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (!s_rx.active) {
        phone_wire_assembler_init(&s_rx, s_in[s_in_tail].json,
                                  sizeof(s_in[s_in_tail].json),
                                  PHONE_WIRE_KIND_MASK(PHONE_WIRE_KIND_COMMAND));
    }
    phone_wire_result_t result = phone_wire_assembler_feed(&s_rx, packet, length);
    if (result == PHONE_WIRE_COMPLETE) {
        phone_request_t *request = &s_in[s_in_tail];
        request->session = s_generation;
        request->id = s_rx.message.id;
        s_in_lengths[s_in_tail] = s_rx.received;
        s_in_tail = (s_in_tail + 1u) % PHONE_QUEUE_DEPTH;
        ++s_in_count;
        /* The assembler must no longer own the now-queued slot. */
        s_rx.buffer = NULL;
        phone_wire_assembler_reset(&s_rx);
    }
    portEXIT_CRITICAL(&s_lock);
    return result == PHONE_WIRE_INVALID ? BLE_ATT_ERR_UNLIKELY : 0;
}

static const struct ble_gatt_chr_def s_characteristics[] = {
    {
        .uuid = &s_rx_uuid.u,
        .access_cb = access_cb,
        .arg = (void *)&s_rx_uuid,
        .flags = BLE_GATT_CHR_F_WRITE,
    },
    {
        .uuid = &s_tx_uuid.u,
        .access_cb = access_cb,
        .flags = BLE_GATT_CHR_F_INDICATE,
        .val_handle = &s_tx_handle,
    },
    {
        .uuid = &s_info_uuid.u,
        .access_cb = access_cb,
        .arg = (void *)&s_info_uuid,
        .flags = BLE_GATT_CHR_F_READ,
    },
    {0},
};
static const struct ble_gatt_svc_def s_services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_service_uuid.u,
        .characteristics = s_characteristics,
    },
    {0},
};

esp_err_t phone_gatt_init(void) {
    if (s_initialized) {
        return ESP_ERR_INVALID_STATE;
    }
    s_adv_mutex = xSemaphoreCreateMutexStatic(&s_adv_mutex_storage);
    if (!s_adv_mutex) {
        return ESP_ERR_NO_MEM;
    }
    ble_npl_event_init(&s_work, host_work, NULL);
    int rc = ble_gatts_count_cfg(s_services);
    if (!rc) {
        rc = ble_gatts_add_svcs(s_services);
    }
    if (rc) {
        return ESP_FAIL;
    }
    s_initialized = true;
    return ESP_OK;
}

void phone_gatt_on_sync(void) {
    portENTER_CRITICAL(&s_lock);
    s_synced = true;
    portEXIT_CRITICAL(&s_lock);
    schedule_work();
}

void phone_gatt_on_reset(void) {
    portENTER_CRITICAL(&s_lock);
    s_synced = false;
    invalidate_locked();
    s_conn = BLE_HS_CONN_HANDLE_NONE;
    s_mtu = 23;
    s_closing = false;
    s_terminate_sent = false;
    s_advertising = false;
    s_suspended = false;
    portEXIT_CRITICAL(&s_lock);
}

bool phone_gatt_gap_event(struct ble_gap_event *event) {
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT: {
        if (event->connect.status) {
            return false; /* Outbound camera attempt; phone failure is ADV_COMPLETE. */
        }
        struct ble_gap_conn_desc desc;
        if (ble_gap_conn_find(event->connect.conn_handle, &desc) ||
            desc.role != BLE_GAP_ROLE_SLAVE) { /* SDK name for PERIPHERAL. */
            return false;
        }
        portENTER_CRITICAL(&s_lock);
        bool extra = s_conn != BLE_HS_CONN_HANDLE_NONE;
        if (!extra) {
            invalidate_locked();
            s_conn = event->connect.conn_handle;
            s_mtu = 23;
            s_closing = false;
            s_terminate_sent = false;
            s_advertising = false;
        }
        portEXIT_CRITICAL(&s_lock);
        if (extra) {
            ble_gap_terminate(event->connect.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
        }
        return true;
    }
    case BLE_GAP_EVENT_DISCONNECT: {
        if (event->disconnect.conn.role != BLE_GAP_ROLE_SLAVE) {
            return false;
        }
        portENTER_CRITICAL(&s_lock);
        if (s_conn == event->disconnect.conn.conn_handle) {
            invalidate_locked();
            s_conn = BLE_HS_CONN_HANDLE_NONE;
            s_mtu = 23;
            s_closing = false;
            s_terminate_sent = false;
        }
        portEXIT_CRITICAL(&s_lock);
        schedule_work();
        return true;
    }
    case BLE_GAP_EVENT_SUBSCRIBE: {
        portENTER_CRITICAL(&s_lock);
        bool own = s_conn == event->subscribe.conn_handle;
        if (own && event->subscribe.attr_handle == s_tx_handle && !s_closing) {
            if (event->subscribe.cur_indicate) {
                s_subscribed = true;
            } else {
                /* Do not allow old in-flight ACKs into a re-subscribed session. */
                close_locked();
            }
        }
        portEXIT_CRITICAL(&s_lock);
        if (own) {
            schedule_work();
        }
        return own;
    }
    case BLE_GAP_EVENT_MTU: {
        portENTER_CRITICAL(&s_lock);
        bool own = s_conn == event->mtu.conn_handle;
        if (own && event->mtu.channel_id == BLE_L2CAP_CID_ATT &&
            event->mtu.value >= 23 && event->mtu.value <= 517) {
            s_mtu = event->mtu.value;
        }
        portEXIT_CRITICAL(&s_lock);
        return own;
    }
    case BLE_GAP_EVENT_NOTIFY_TX: {
        portENTER_CRITICAL(&s_lock);
        bool own = s_conn == event->notify_tx.conn_handle;
        if (own && event->notify_tx.attr_handle == s_tx_handle &&
            event->notify_tx.indication && s_pending && !s_closing) {
            if (event->notify_tx.status == BLE_HS_EDONE) {
                s_tx_offset += s_pending_bytes;
                s_pending = false;
                s_pending_bytes = 0;
                if (s_out_count && s_tx_offset == s_out[s_out_head].length) {
                    s_out_head = (s_out_head + 1u) % PHONE_QUEUE_DEPTH;
                    --s_out_count;
                    s_tx_offset = 0;
                }
            } else if (event->notify_tx.status != 0) {
                close_locked();
            }
        }
        portEXIT_CRITICAL(&s_lock);
        if (own) {
            schedule_work();
        }
        return own;
    }
    case BLE_GAP_EVENT_ADV_COMPLETE: {
        portENTER_CRITICAL(&s_lock);
        bool own = s_advertising;
        if (own) {
            s_advertising = false;
        }
        portEXIT_CRITICAL(&s_lock);
        if (own) {
            schedule_work();
        }
        return own;
    }
    default:
        return false;
    }
}

void phone_gatt_poll(uint64_t now_ms) {
    portENTER_CRITICAL(&s_lock);
    if (s_pending && now_ms >= s_pending_since &&
        now_ms - s_pending_since >= PHONE_CONFIRM_TIMEOUT_MS) {
        close_locked();
    }
    bool needs_work = s_synced &&
        ((s_closing && !s_terminate_sent) ||
         (s_out_count && !s_pending && !s_closing) ||
         (s_conn == BLE_HS_CONN_HANDLE_NONE && !s_suspended && !s_advertising));
    portEXIT_CRITICAL(&s_lock);
    if (needs_work) {
        schedule_work();
    }
}

uint32_t phone_gatt_session(void) {
    portENTER_CRITICAL(&s_lock);
    uint32_t session = usable_locked(s_generation) ? s_generation : 0;
    portEXIT_CRITICAL(&s_lock);
    return session;
}

bool phone_gatt_take_request(phone_request_t *out) {
    if (!out) {
        return false;
    }
    portENTER_CRITICAL(&s_lock);
    bool available = usable_locked(s_generation) && s_in_count &&
                     s_in[s_in_head].session == s_generation;
    if (available) {
        out->session = s_in[s_in_head].session;
        out->id = s_in[s_in_head].id;
        memcpy(out->json, s_in[s_in_head].json, s_in_lengths[s_in_head] + 1u);
        s_in_head = (s_in_head + 1u) % PHONE_QUEUE_DEPTH;
        --s_in_count;
    }
    portEXIT_CRITICAL(&s_lock);
    return available;
}

bool phone_gatt_can_send(uint32_t session) {
    portENTER_CRITICAL(&s_lock);
    bool available = usable_locked(session) && s_out_count < PHONE_QUEUE_DEPTH;
    portEXIT_CRITICAL(&s_lock);
    return available;
}

bool phone_gatt_tx_idle(uint32_t session) {
    portENTER_CRITICAL(&s_lock);
    bool idle = usable_locked(session) && !s_out_count && !s_pending;
    portEXIT_CRITICAL(&s_lock);
    return idle;
}

bool phone_gatt_send(uint32_t session, uint16_t id, uint8_t kind,
                     const char *json, size_t length) {
    if (!json || !length || length > PHONE_MESSAGE_MAX ||
        kind < PHONE_KIND_REPLY || kind > PHONE_KIND_LOG_END ||
        (kind == PHONE_KIND_STATUS ? id != 0 : id == 0)) {
        return false;
    }
    portENTER_CRITICAL(&s_lock);
    bool current = usable_locked(session);
    bool available = current && s_out_count < PHONE_QUEUE_DEPTH;
    if (available) {
        phone_message_t *message = &s_out[s_out_tail];
        message->session = session;
        message->id = id;
        message->kind = kind;
        message->length = (uint16_t)length;
        memcpy(message->json, json, length);
        s_out_tail = (s_out_tail + 1u) % PHONE_QUEUE_DEPTH;
        ++s_out_count;
    } else if (current) {
        /* An overflow must never hide an executed command's missing reply. */
        close_locked();
    }
    portEXIT_CRITICAL(&s_lock);
    if (current) {
        schedule_work();
    }
    return available;
}

void phone_gatt_drop(uint32_t session) {
    portENTER_CRITICAL(&s_lock);
    if (usable_locked(session)) {
        close_locked();
    }
    portEXIT_CRITICAL(&s_lock);
    schedule_work();
}

void phone_gatt_suspend_advertising(bool suspended) {
    if (!s_initialized) {
        return;
    }
    xSemaphoreTake(s_adv_mutex, portMAX_DELAY);
    portENTER_CRITICAL(&s_lock);
    s_suspended = suspended;
    bool stop = suspended && s_advertising;
    if (stop) {
        s_advertising = false;
    }
    portEXIT_CRITICAL(&s_lock);
    if (stop) {
        ble_gap_adv_stop();
    }
    xSemaphoreGive(s_adv_mutex);
    if (!suspended) {
        /* A separate host event, not stop/start in the same event context. */
        schedule_work();
    }
}
