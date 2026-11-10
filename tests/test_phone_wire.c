#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "phone_wire.h"

static void round_trip(uint8_t kind, uint16_t id, size_t length,
                       size_t packet_bytes) {
    char input[PHONE_WIRE_MESSAGE_MAX + 1];
    char output[PHONE_WIRE_MESSAGE_MAX + 2];
    memset(input, 'x', length);
    input[length] = '\0';
    memset(output, '!', sizeof(output));
    phone_wire_assembler_t assembler;
    phone_wire_assembler_init(&assembler, output, length + 1,
                              PHONE_WIRE_KIND_MASK(kind));
    uint8_t packet[514];
    size_t offset = 0;
    size_t fragments = 0;
    while (offset < length) {
        size_t bytes = phone_wire_fragment(kind, id, input, length, offset,
                                           packet_bytes, packet, sizeof(packet));
        assert(bytes > PHONE_WIRE_HEADER_BYTES && bytes <= packet_bytes);
        phone_wire_header_t header;
        assert(phone_wire_header_decode(packet, bytes, &header));
        assert(header.id == id && header.kind == kind && header.total == length);
        assert(header.offset == offset);
        size_t payload = bytes - PHONE_WIRE_HEADER_BYTES;
        phone_wire_result_t expected = offset + payload == length
                                           ? PHONE_WIRE_COMPLETE : PHONE_WIRE_PARTIAL;
        assert(phone_wire_assembler_feed(&assembler, packet, bytes) == expected);
        offset += payload;
        ++fragments;
    }
    size_t per_fragment = packet_bytes - PHONE_WIRE_HEADER_BYTES;
    assert(fragments == (length + per_fragment - 1) / per_fragment);
    assert(assembler.received == length && !assembler.active);
    assert(assembler.message.id == id && assembler.message.kind == kind);
    assert(memcmp(input, output, length + 1) == 0);
    assert(output[length + 1] == '!');
}

static void test_mtu_and_limits(void) {
    /* Minimum MTU 23 gives a 20-byte ATT value and 12 JSON bytes per frame. */
    round_trip(PHONE_WIRE_KIND_COMMAND, 0x1234, 1, 20);
    round_trip(PHONE_WIRE_KIND_COMMAND, 0xffff, PHONE_WIRE_COMMAND_MAX, 20);
    round_trip(PHONE_WIRE_KIND_LOG_EVENT, 5, PHONE_WIRE_MESSAGE_MAX, 20);
    round_trip(PHONE_WIRE_KIND_REPLY, 1, PHONE_WIRE_MESSAGE_MAX, 512);
    round_trip(PHONE_WIRE_KIND_STATUS, 0, 24, 20);
    for (uint8_t kind = PHONE_WIRE_KIND_REPLY; kind <= PHONE_WIRE_KIND_LOG_END; ++kind) {
        round_trip(kind, kind == PHONE_WIRE_KIND_STATUS ? 0 : 1, 13, 20);
    }

    uint8_t packet[32];
    static const char message[] = "abcdefghijklmnop";
    assert(phone_wire_fragment(PHONE_WIRE_KIND_COMMAND, 0x1234, message, 16,
                               0, 20, packet, sizeof(packet)) == 20);
    const uint8_t expected[] = {1, 0, 0x34, 0x12, 0, 0, 16, 0};
    assert(memcmp(packet, expected, sizeof(expected)) == 0);
    assert(memcmp(packet + 8, message, 12) == 0);
    assert(phone_wire_fragment(0, 1, message, 16, 16, 20, packet, 32) == 0);
    assert(phone_wire_fragment(0, 1, message, 16, 0, 8, packet, 32) == 0);
    assert(phone_wire_fragment(0, 1, message, 16, 0, 20, packet, 19) == 0);
    assert(phone_wire_fragment(0, 1, NULL, 16, 0, 20, packet, 32) == 0);
    assert(!phone_wire_header_encode(packet, 0, 1, 0, 768, 1));
    assert(!phone_wire_header_encode(packet, 1, 1, 0, 4097, 1));
    assert(!phone_wire_header_encode(packet, 1, 1, 0, 65536, 1));
    assert(!phone_wire_header_encode(packet, 1, 1, 0, 0, 1));
    assert(!phone_wire_header_encode(packet, 1, 1, 0, 1, 0));
    assert(!phone_wire_header_encode(packet, 1, 1, 1, 1, 1));
    assert(!phone_wire_header_encode(packet, 1, 1, 0, 1, 2));
    assert(!phone_wire_header_encode(packet, 6, 1, 0, 1, 1));
    assert(!phone_wire_header_encode(packet, PHONE_WIRE_KIND_STATUS, 1, 0, 1, 1));
    for (uint8_t kind = 0; kind <= 5; ++kind) {
        assert(phone_wire_header_encode(packet, kind, 0, 0, 1, 1) ==
               (kind == PHONE_WIRE_KIND_STATUS));
    }
}

static size_t command_fragment(uint8_t *packet, uint16_t id, size_t offset) {
    static const char command[] = "{\"cmd\":\"GET_STATUS\"}";
    return phone_wire_fragment(PHONE_WIRE_KIND_COMMAND, id, command,
                               sizeof(command) - 1, offset, 20, packet, 20);
}

static void test_discontinuity_and_reset(void) {
    char output[PHONE_WIRE_COMMAND_MAX + 1];
    phone_wire_assembler_t assembler;
    phone_wire_assembler_init(&assembler, output, sizeof(output),
                              PHONE_WIRE_KIND_MASK(PHONE_WIRE_KIND_COMMAND));
    uint8_t packet[20];
    size_t bytes = command_fragment(packet, 7, 0);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_PARTIAL);
    assert(assembler.active && assembler.received == 12);
    /* A second offset-zero frame may not replace an unfinished command. */
    bytes = command_fragment(packet, 8, 0);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    assert(!assembler.active && !assembler.received && !output[0]);
    bytes = command_fragment(packet, 7, 12);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    bytes = command_fragment(packet, 7, 0);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_PARTIAL);
    bytes = command_fragment(packet, 7, 13); /* Gap. */
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    bytes = command_fragment(packet, 7, 0);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_PARTIAL);
    bytes = command_fragment(packet, 7, 11); /* Overlap. */
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    bytes = command_fragment(packet, 7, 0);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_PARTIAL);
    bytes = command_fragment(packet, 8, 12); /* Interleaved request ID. */
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    bytes = command_fragment(packet, 7, 0);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_PARTIAL);
    bytes = command_fragment(packet, 7, 12);
    ++packet[6]; /* Changed total on continuation. */
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    bytes = command_fragment(packet, 7, 0);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_PARTIAL);
    phone_wire_assembler_reset(&assembler); /* Disconnect/reset. */
    assert(!assembler.active && !assembler.received && !output[0]);
    bytes = command_fragment(packet, 7, 12);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    bytes = command_fragment(packet, 9, 0);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_PARTIAL);
    bytes = command_fragment(packet, 9, 12);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_COMPLETE);
    assert(strcmp(output, "{\"cmd\":\"GET_STATUS\"}") == 0);
    /* Reusing an ID for separate logical LOG_EVENT messages is supported. */
    phone_wire_assembler_init(&assembler, output, sizeof(output),
                              PHONE_WIRE_KIND_MASK(PHONE_WIRE_KIND_LOG_EVENT));
    for (unsigned i = 0; i < 2; ++i) {
        bytes = phone_wire_fragment(PHONE_WIRE_KIND_LOG_EVENT, 9, "{}", 2,
                                    0, 20, packet, sizeof(packet));
        assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_COMPLETE);
    }
}

static void test_malformed_and_kinds(void) {
    char output[PHONE_WIRE_COMMAND_MAX + 1];
    phone_wire_assembler_t assembler;
    phone_wire_assembler_init(&assembler, output, sizeof(output), 1u);
    uint8_t packet[20];
    phone_wire_header_t header;
    size_t bytes = command_fragment(packet, 1, 0);
    assert(!phone_wire_header_decode(packet, 8, &header));
    assert(!phone_wire_header_decode(NULL, bytes, &header));
    packet[0] = 2;
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    bytes = command_fragment(packet, 1, 0);
    packet[1] = 255;
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    bytes = command_fragment(packet, 1, 0);
    packet[2] = 0;
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    bytes = command_fragment(packet, 1, 0);
    packet[6] = 0;
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    bytes = command_fragment(packet, 1, 0);
    packet[6] = 0; packet[7] = 3; /* 768-byte RX command, over its own bound. */
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    for (uint8_t kind = 1; kind <= 5; ++kind) {
        bytes = phone_wire_fragment(kind, 1, "{}", 2, 0, 20, packet, 20);
        assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    }
    bytes = command_fragment(packet, 1, 0);
    phone_wire_assembler_init(&assembler, output, 12, 1u);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    phone_wire_assembler_init(&assembler, NULL, 0, 1u);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
    /* Kind changes cannot interleave even when both kinds are allowed. */
    phone_wire_assembler_init(&assembler, output, sizeof(output), 3u);
    bytes = command_fragment(packet, 1, 0);
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_PARTIAL);
    bytes = command_fragment(packet, 1, 12);
    packet[1] = PHONE_WIRE_KIND_REPLY;
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
}

static void test_utf8(void) {
    char output[64];
    uint8_t packet[64];
    phone_wire_assembler_t assembler;
    phone_wire_assembler_init(&assembler, output, sizeof(output), 1u);
    /* All UTF-8 widths, including scalars at their upper limits. */
    const char valid[] = "{\"x\":\"\xc2\x80\xe0\xa0\x80\xed\x9f\xbf\xf0\x90\x80\x80\xf4\x8f\xbf\xbf\"}";
    for (size_t offset = 0; offset < sizeof(valid) - 1;) {
        size_t bytes = phone_wire_fragment(0, 1, valid, sizeof(valid) - 1,
                                           offset, 20, packet, sizeof(packet));
        size_t next = offset + bytes - 8;
        assert(phone_wire_assembler_feed(&assembler, packet, bytes) ==
               (next == sizeof(valid) - 1 ? PHONE_WIRE_COMPLETE : PHONE_WIRE_PARTIAL));
        offset = next;
    }
    static const char *const invalid[] = {
        "\x80", "\xc0\x80", "\xe0\x80\x80", "\xed\xa0\x80", "\xf4\x90\x80\x80",
        "\xf5\x80\x80\x80", "\xc2", "\xe1\x80", "\xf1\x80\x80", "\xc2x"
    };
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        size_t bytes = phone_wire_fragment(0, 1, invalid[i], strlen(invalid[i]),
                                           0, 64, packet, sizeof(packet));
        assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
        assert(!output[0]);
    }
    const char embedded_nul[] = {'{', '}', '\0', 'x'};
    size_t bytes = phone_wire_fragment(0, 1, embedded_nul, sizeof(embedded_nul),
                                       0, 64, packet, sizeof(packet));
    assert(phone_wire_assembler_feed(&assembler, packet, bytes) == PHONE_WIRE_INVALID);
}

int main(void) {
    test_mtu_and_limits();
    test_discontinuity_and_reset();
    test_malformed_and_kinds();
    test_utf8();
    puts("phone wire: all tests passed");
    return 0;
}
