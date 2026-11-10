#include "phone_wire.h"
#include <string.h>

static uint16_t read16(const uint8_t *p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static void write16(uint8_t *p, uint16_t value) {
    p[0] = (uint8_t)value;
    p[1] = (uint8_t)(value >> 8);
}

static bool valid_header(uint8_t kind, uint16_t id, size_t offset, size_t total,
                         size_t payload_length) {
    if (kind > PHONE_WIRE_KIND_LOG_END ||
        (kind == PHONE_WIRE_KIND_STATUS ? id != 0 : id == 0) ||
        !total || total > PHONE_WIRE_MESSAGE_MAX || !payload_length ||
        offset >= total || payload_length > total - offset) {
        return false;
    }
    return kind != PHONE_WIRE_KIND_COMMAND || total <= PHONE_WIRE_COMMAND_MAX;
}
/* JSON must be UTF-8; cJSON's syntax parser does not validate UTF-8 itself. */
static bool valid_utf8(const char *text, size_t length) {
    const uint8_t *p = (const uint8_t *)text;
    for (size_t i = 0; i < length;) {
        uint8_t first = p[i++];
        if (first && first < 0x80) {
            continue;
        }
        unsigned remaining;
        uint8_t second_min = 0x80, second_max = 0xbf;
        if (first >= 0xc2 && first <= 0xdf) {
            remaining = 1;
        } else if (first >= 0xe0 && first <= 0xef) {
            remaining = 2;
            if (first == 0xe0) second_min = 0xa0;
            if (first == 0xed) second_max = 0x9f;
        } else if (first >= 0xf0 && first <= 0xf4) {
            remaining = 3;
            if (first == 0xf0) second_min = 0x90;
            if (first == 0xf4) second_max = 0x8f;
        } else {
            return false;
        }
        if (remaining > length - i || p[i] < second_min || p[i] > second_max) {
            return false;
        }
        ++i;
        while (--remaining) {
            if (p[i] < 0x80 || p[i] > 0xbf) {
                return false;
            }
            ++i;
        }
    }
    return true;
}


bool phone_wire_header_decode(const uint8_t *packet, size_t length,
                              phone_wire_header_t *header) {
    if (!packet || !header || length > 512 || length <= PHONE_WIRE_HEADER_BYTES ||
        packet[0] != PHONE_WIRE_VERSION) {
        return false;
    }
    uint8_t kind = packet[1];
    uint16_t id = read16(packet + 2);
    uint16_t offset = read16(packet + 4);
    uint16_t total = read16(packet + 6);
    if (!valid_header(kind, id, offset, total, length - PHONE_WIRE_HEADER_BYTES)) {
        return false;
    }
    header->kind = kind;
    header->id = id;
    header->offset = offset;
    header->total = total;
    return true;
}

bool phone_wire_header_encode(uint8_t out[PHONE_WIRE_HEADER_BYTES], uint8_t kind,
                              uint16_t id, size_t offset, size_t total,
                              size_t payload_length) {
    if (!out || !valid_header(kind, id, offset, total, payload_length)) {
        return false;
    }
    out[0] = PHONE_WIRE_VERSION;
    out[1] = kind;
    write16(out + 2, id);
    write16(out + 4, (uint16_t)offset);
    write16(out + 6, (uint16_t)total);
    return true;
}

size_t phone_wire_fragment(uint8_t kind, uint16_t id, const char *message,
                           size_t length, size_t offset, size_t packet_bytes,
                           uint8_t *out, size_t out_capacity) {
    if (!message || packet_bytes > 512 || packet_bytes <= PHONE_WIRE_HEADER_BYTES || offset >= length) {
        return 0;
    }
    size_t payload = length - offset;
    if (payload > packet_bytes - PHONE_WIRE_HEADER_BYTES) {
        payload = packet_bytes - PHONE_WIRE_HEADER_BYTES;
    }
    if (out_capacity < PHONE_WIRE_HEADER_BYTES + payload ||
        !phone_wire_header_encode(out, kind, id, offset, length, payload)) {
        return 0;
    }
    memcpy(out + PHONE_WIRE_HEADER_BYTES, message + offset, payload);
    return PHONE_WIRE_HEADER_BYTES + payload;
}

void phone_wire_assembler_reset(phone_wire_assembler_t *assembler) {
    assembler->active = false;
    assembler->received = 0;
    assembler->message = (phone_wire_header_t){0};
    if (assembler->buffer && assembler->capacity) {
        assembler->buffer[0] = '\0';
    }
}

void phone_wire_assembler_init(phone_wire_assembler_t *assembler, char *buffer,
                               size_t capacity, uint32_t allowed_kinds) {
    assembler->buffer = buffer;
    assembler->capacity = capacity;
    assembler->kinds = allowed_kinds;
    phone_wire_assembler_reset(assembler);
}

phone_wire_result_t phone_wire_assembler_feed(phone_wire_assembler_t *assembler,
                                             const uint8_t *packet, size_t length) {
    phone_wire_header_t header;
    if (!assembler->buffer || !assembler->capacity ||
        !phone_wire_header_decode(packet, length, &header) ||
        !(assembler->kinds & PHONE_WIRE_KIND_MASK(header.kind)) ||
        header.total >= assembler->capacity) {
        phone_wire_assembler_reset(assembler);
        return PHONE_WIRE_INVALID;
    }
    if (assembler->active) {
        if (header.id != assembler->message.id ||
            header.kind != assembler->message.kind ||
            header.total != assembler->message.total ||
            header.offset != assembler->received) {
            phone_wire_assembler_reset(assembler);
            return PHONE_WIRE_INVALID;
        }
    } else {
        if (header.offset != 0) {
            phone_wire_assembler_reset(assembler);
            return PHONE_WIRE_INVALID;
        }
        assembler->message = header;
        assembler->active = true;
    }
    size_t payload = length - PHONE_WIRE_HEADER_BYTES;
    memcpy(assembler->buffer + header.offset, packet + PHONE_WIRE_HEADER_BYTES,
           payload);
    assembler->received = (uint16_t)(header.offset + payload);
    assembler->buffer[assembler->received] = '\0';
    if (assembler->received == header.total) {
        if (!valid_utf8(assembler->buffer, header.total)) {
            phone_wire_assembler_reset(assembler);
            return PHONE_WIRE_INVALID;
        }
        assembler->active = false;
        return PHONE_WIRE_COMPLETE;
    }
    return PHONE_WIRE_PARTIAL;
}
