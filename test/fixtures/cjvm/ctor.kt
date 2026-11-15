package probe

val top = 3
var hits = 0

class A(x: Int, val y: Int) {
    val z = x + 1
    init {
        println(x + top)
    }
    fun f(x: Int) = x * y
}

public class B(private val w: Int, q: Int) {
    val r = q * 2
    fun g(q: Int): Int {
        hits++
        return q + w
    }
}

interface Shape {
    fun area(scale: Double): Double
    val name: String
}

fun h(x: Int) {
    val k = x + top
    println(k)
}

fun twice(x: Int, f: (value: Int) -> Int): Int = f(f(x))
