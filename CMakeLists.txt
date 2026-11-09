# The following lines of boilerplate have to be in your project's CMakeLists
# in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# "Trim" the build. Include the minimal set of components, main, and anything it depends on.
idf_build_set_property(MINIMAL_BUILD ON)
if(IDF_TARGET STREQUAL "esp32c3")
    idf_build_set_property(DEPENDENCIES_LOCK "${CMAKE_BINARY_DIR}/dependencies.lock")
endif()
project(dji_camera_bluetooth_control)
