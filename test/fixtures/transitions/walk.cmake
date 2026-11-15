cmake_minimum_required(VERSION 3.20)
project(demo VERSION 1.2.3 LANGUAGES C CXX)

set(SOURCES src/main.c src/util.c)
option(DEMO_TESTS "Build tests" ON)

if(DEMO_TESTS AND NOT CMAKE_CROSSCOMPILING)
  enable_testing()
endif()

function(add_demo name)
  set(options SHARED)
  cmake_parse_arguments(ARG "${options}" "" "SOURCES" ${ARGN})
  add_library(${name} ${ARG_SOURCES})
  target_compile_definitions(${name} PRIVATE DEMO_NAME="${name}" VERSION=${PROJECT_VERSION})
  message(STATUS "demo ${name}: $ENV{HOME} $<TARGET_FILE:${name}>")
endfunction()

foreach(src IN LISTS SOURCES)
  get_filename_component(stem ${src} NAME_WE)
  list(APPEND STEMS ${stem})
endforeach()

add_demo(core SOURCES ${SOURCES})
# a comment with 'quotes' and ${NOT_A_VAR}
