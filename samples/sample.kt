// Sample Kotlin file for exercising the Okibi dynamic focus layer.
// Move the caret into different { } blocks and watch the ember bar + fill.
// Type to flip Survey 構 -> Focus 流 -> Edit 異 (status bar, bottom-right).
//
// What to look for:
//   Focus 流 — data identities tint (locals, params, `this`, lambda `it` /
//     captured vars). Class/type names, property names, function names stay
//     band-1.
//   Edit 異 — numbers go clay; writes escaping the block get a dashed underline.
//   Stability — a variable keeps one hue across sub-blocks and lambdas.

package samples

const val MAX_RETRIES = 3
const val DEFAULT_TIMEOUT = 30

// a top-level property — bold identity when referenced
var totalCalls = 0

enum class Status { PENDING, ACTIVE, CLOSED }

// data class: property names are band-1, not data
data class Config(
    val name: String,
    val retries: Int = MAX_RETRIES,
    val timeout: Int = DEFAULT_TIMEOUT,
    val tags: Map<String, String> = emptyMap(),
)

// sealed hierarchy — type names band-1
sealed class Result {
    data class Ok(val bytes: Int) : Result()
    data class Err(val reason: String) : Result()
}

// function type alias — a transformer identity
typealias Handler = (Config) -> Result

fun loadConfig(name: String): Config {
    val cfg = Config(name = name, tags = mapOf("env" to "dev"))

    if (cfg.retries > 0) {
        for (i in 0 until cfg.retries) {
            // deepest block — cfg + i + backoff are data identities
            val backoff = 1 shl i
            println("attempt $i for ${cfg.name} (backoff=${backoff}ms)")
        }
    }

    totalCalls += 1 // escapes the block — writes the top-level property
    return cfg
}

// closures: lambda `it` / captured `prefix` keep stable hues across filter/map
fun summarize(cfgs: List<Config>): String {
    val prefix = "cfg"
    return cfgs
        .filter { it.name.isNotEmpty() }
        .joinToString("; ") { c -> "$prefix:${c.name} x${c.retries}" }
}

// generics: T is a type param (band-1); acc/item are data
fun <T> fold(cfgs: List<Config>, seed: T, reducer: (T, Config) -> T): T {
    var acc = seed
    for (item in cfgs) {
        acc = reducer(acc, item)
    }
    return acc
}

// extension function — receiver `this` is the keyword colour
fun Config.describe(): String {
    val envs = this.tags.keys.joinToString(",")
    return "${this.name} retries=${this.retries} envs=[$envs]"
}

// class: `this` is the keyword colour; methods are band-1
class Worker(private val id: String) {
    private var seen = 0
    private val history = mutableListOf<String>()

    fun process(cfg: Config): Result {
        this.seen += 1 // write to a this-bound property → escapes the block
        val bytes = cfg.name.length
        return if (bytes > 3) {
            this.seen += bytes
            history.add(cfg.name)
            Result.Ok(bytes)
        } else {
            Result.Err("too short: ${cfg.name}")
        }
    }

    fun score(): Int = seen
}

fun main() {
    val cfgs = listOf("alpha", "beta", "gamma").map { loadConfig(it) }
    val worker = Worker("w-1")

    var total = 0
    for (cfg in cfgs) {
        total += cfg.retries // escapes the loop — writes outer `total`
        when (val result = worker.process(cfg)) {
            is Result.Ok -> println("ok: ${result.bytes} bytes")
            is Result.Err -> println("err: ${result.reason}")
        }
    }

    val timeoutSum = fold(cfgs, 0) { acc, item -> acc + item.timeout }

    println(summarize(cfgs))
    println(cfgs.first().describe())
    println("score=${worker.score()} total=$total timeouts=$timeoutSum calls=$totalCalls")
}
