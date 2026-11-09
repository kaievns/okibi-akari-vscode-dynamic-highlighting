var counter = 0

class Box(var retries: Int) {
    fun bump(delta: Int = 1) {
        val next = retries + delta
        retries = next
        counter += 1
        connect(host = "x", retries = next)
    }
}

fun connect(host: String, retries: Int = 3): Int {
    var left = retries
    while (left > 0) {
        left -= 1
    }
    return left
}
