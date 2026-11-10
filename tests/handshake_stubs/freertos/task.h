#include <stdint.h>
extern uint32_t test_handshake_ticks;
static inline uint32_t xTaskGetTickCount(void) { return test_handshake_ticks; }
static inline void vTaskDelay(uint32_t ticks) { (void)ticks; }
