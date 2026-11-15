plugins {
    kotlin("jvm") version "2.0.0"
    application
}

val ktorVersion: String by project
val junit = "5.10.2"

repositories {
    mavenCentral()
}

dependencies {
    implementation("io.ktor:ktor-server-core:$ktorVersion")
    testImplementation("org.junit.jupiter:junit-jupiter:${junit}")
}

tasks.register("hello") {
    val greeting = "hello"
    doLast {
        repeat(3) { i -> println("$greeting #$i") }
    }
}

kotlin {
    jvmToolchain(21)
}
