#ifndef HEADLESS_PHONE_WIRE_H
#define HEADLESS_PHONE_WIRE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PHONE_WIRE_VERSION 1u
#define PHONE_WIRE_HEADER_BYTES 8u
#define PHONE_WIRE_COMMAND_MAX 767u
#define PHONE_WIRE_MESSAGE_MAX 4096u
#define PHONE_WIRE_DEFAULT_PACKET_BYTES 20u
#define PHONE_WIRE_KIND_COMMAND 0u
#define PHONE_WIRE_KIND_REPLY 1u
#define PHONE_WIRE_KIND_STATUS 2u
#define PHONE_WIRE_KIND_LOG_BEGIN 3u
#define PHONE_WIRE_KIND_LOG_EVENT 4u
#define PHONE_WIRE_KIND_LOG_END 5u
#define PHONE_WIRE_KIND_MASK(kind) (1u << (kind))

typedef struct {
    uint8_t kind;
    uint16_t id;
    uint16_t offset;
    uint16_t total;
} phone_wire_header_t;

typedef struct {
    char *buffer;
    size_t capacity; /* Includes the trailing NUL byte. */
    uint32_t kinds;
    phone_wire_header_t message;
    uint16_t received;
    bool active;
} phone_wire_assembler_t;

typedef enum {
    PHONE_WIRE_INVALID = -1,
    PHONE_WIRE_PARTIAL = 0,
    PHONE_WIRE_COMPLETE = 1
} phone_wire_result_t;

bool phone_wire_header_decode(const uint8_t *packet, size_t length,
                              phone_wire_header_t *header);
bool phone_wire_header_encode(uint8_t out[PHONE_WIRE_HEADER_BYTES], uint8_t kind,
                              uint16_t id, size_t offset, size_t total,
                              size_t payload_length);
/* packet_bytes is the ATT value limit (MTU minus three), not the MTU. */
size_t phone_wire_fragment(uint8_t kind, uint16_t id, const char *message,
                           size_t length, size_t offset, size_t packet_bytes,
                           uint8_t *out, size_t out_capacity);
void phone_wire_assembler_init(phone_wire_assembler_t *assembler, char *buffer,
                               size_t capacity, uint32_t allowed_kinds);
void phone_wire_assembler_reset(phone_wire_assembler_t *assembler);
/* A completed message remains in buffer until the next feed/reset. Any malformed
 * frame clears the partial message, including attempted interleaving at offset 0. */
phone_wire_result_t phone_wire_assembler_feed(phone_wire_assembler_t *assembler,
                                             const uint8_t *packet, size_t length);

#endif
