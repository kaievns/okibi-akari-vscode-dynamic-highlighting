package fixtures

import groovy.transform.CompileStatic

@CompileStatic
class Inventory {
    static final int LIMIT = 5
    private Map<String, Integer> stock = [:]
    int touched = 0

    Inventory(Map<String, Integer> start) {
        this.stock = start
    }

    def add(String name, int count = 1) {
        stock[name] = (stock[name] ?: 0) + count
        touched++
        return this
    }

    String report() {
        def lines = stock.collect { k, v -> "${k}: $v" }
        String header = 'Report'
        def multi = """
            ${header}
            ${lines.join('\n')}
        """
        def pattern = /item-\d+/
        def dollar = $/path\to\$header/$
        return multi + pattern + dollar
    }
}

def inv = new Inventory([apple: 2])
inv.add('pear').add('fig', 3)
def total = 0
inv.stock.each { name, count ->
    total += count
    println "item $name x$count"
}
[1, 2, 3].each { total += it }
def squares = (1..LIMIT).collect { n -> n * n }
println String.format('%d items, %s', total, squares)
