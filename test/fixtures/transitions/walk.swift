import Foundation

public struct Circle: Hashable {
    public var radius: Double
    public var area: Double { .pi * radius * radius }

    public init(radius: Double) {
        self.radius = radius
    }

    public func scaled(by factor: Double) -> Circle {
        Circle(radius: radius * factor)
    }
}

public final class Counter: @unchecked Sendable {
    private var total = 0 {
        didSet { print("did", oldValue, total) }
    }
    nonisolated(unsafe) static var shared = Counter()

    @discardableResult
    public func add(_ amount: Int, times count: Int = 1) -> Int {
        for _ in 0..<count {
            total += amount
        }
        return total
    }
}

public actor Bank {
    private var balances: [String: Int] = [:]

    public func deposit(_ amount: Int, to account: String) async {
        balances[account, default: 0] += amount
    }
}

public func load(from url: URL, bank: Bank) async throws -> Int {
    let (data, response) = try await URLSession.shared.data(from: url)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        throw URLError(.badServerResponse)
    }
    let text = String(decoding: data, as: UTF8.self)
    let json = try JSONSerialization.jsonObject(with: data)
    await bank.deposit(text.count, to: "main")
    return http.statusCode
}

public func sorted(_ items: [Circle]) -> [Circle] {
    let byArea = items.sorted { $0.area < $1.area }
    let names = items.map { circle in "r=\(circle.radius)" }
    _ = names.filter { name in name.count > 3 }
    return byArea
}

public func parse(_ input: String?) throws -> Int {
    guard let input, !input.isEmpty else { return 0 }
    if let value = Int(input) {
        return value
    }
    let forced = Int(input)!
    let any: Any = forced
    let cast = any as! Int
    let attempt = try! JSONSerialization.jsonObject(with: Data())
    _ = attempt
    return cast
}

public func strings(name: String, count: Int) -> [String] {
    let simple = "Hello, \(name)! You have \(count + 1) items"
    let raw = #"raw \(name) stays, \#(name) interpolates"#
    let multi = """
        Dear \(name),
          count: \(count)
        """
    return [simple, raw, multi]
}

public func regexes(_ line: String) -> Int {
    let digits = #/\d+/#
    var hits = 0
    if line.contains(digits) { hits += 1 }
    let ratio = 10 / 2 / 5
    return hits + ratio
}

public func loops(_ grid: [[Int]]) -> Int {
    var found = 0
    outer: for row in grid {
        for cell in row where cell > 0 {
            if cell == 99 { break outer }
            found += cell
        }
    }
    switch found {
    case 0:
        fallthrough
    default:
        found *= 2
    }
    return found
}

#if os(macOS)
let platformName = "macOS"
#else
let platformName = "other"
#endif
