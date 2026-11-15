package fixtures

import kotlin.math.max
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

const val LIMIT = 10
var counter = 0

data class User(val name: String, val age: Int, val tags: List<String> = emptyList())

sealed class Event {
    data class Click(val x: Int, val y: Int) : Event()
    object Close : Event()
}

class Account(private val owner: String) {
    private var balance = 0
    lateinit var label: String
    val history by lazy { mutableListOf<String>() }

    init {
        balance = owner.length
        this.label = "acct"
    }

    constructor(owner: String, start: Int) : this(owner) {
        balance = start
    }

    fun deposit(amount: Int): Int {
        balance += amount
        this.balance += 0
        history.add("deposit $amount -> ${this.balance}")
        return balance
    }

    companion object {
        @JvmStatic
        fun empty() = Account("nobody")
    }
}

fun String.shout(times: Int = 1): String = uppercase().repeat(times)

infix fun Int.over(other: Int): Double = this.toDouble() / other

inline fun <reified T> List<*>.firstOf(): T? = firstOrNull { it is T } as? T

fun handle(event: Event): String = when (event) {
    is Event.Click -> "click at ${event.x},${event.y}"
    Event.Close -> "close"
}

fun scan(users: List<User>, lookup: Map<String, Int>): Int {
    var total = 0
    outer@ for (user in users) {
        for ((key, value) in lookup) {
            if (value < 0) break@outer
            if (key == user.name) continue@outer
            total += value
        }
    }
    users.forEach { u ->
        if (u.age > LIMIT) return@forEach
        total += u.age
    }
    val (name, age) = users.first()
    val adults = users.filter { it.age >= 18 }.map { it.name }
    counter++
    return total + age + name.length + adults.size
}

fun scopes(user: User?): String {
    val n = user?.let { it.name.length } ?: return "none"
    val described = user.run { "$name is $age" }
    val copy = user.copy(name = "x").also { println(it) }
    val built = StringBuilder().apply {
        append(copy.name)
        append(n)
    }.toString()
    with(user) {
        println(tags.size + age)
    }
    return described + built
}

fun casts(raw: Any?, items: List<Any>): Int {
    val s = raw as String
    val maybe = raw as? Int
    val forced = maybe!!
    @Suppress("UNCHECKED_CAST")
    val strings = items as List<String>
    val len = strings.size + s.length + forced
    return len
}

suspend fun fetch(id: Int): String = "item-$id"

fun main(args: Array<String>) = runBlocking {
    val account = Account("ann", 5)
    launch {
        val item = fetch(3)
        println("got $item for ${account.deposit(2)}")
    }
    val raw = """
        |user: ${args.size}
        |limit: $LIMIT
    """.trimMargin()
    val fn = fun(x: Int): Int { return x * 2 }
    val total = try { raw.length } catch (e: IllegalStateException) { -1 } finally { counter = 0 }
    println(String.format("%d %s", total, fn(max(1, 2))))
    println("${3 over 4} ${"hi".shout()}")
}
