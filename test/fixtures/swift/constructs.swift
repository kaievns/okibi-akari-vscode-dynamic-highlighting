import Foundation
import os.log

/// A synthetic file covering the Swift constructs the companion reads.
public protocol Shape: Sendable {
    associatedtype Unit
    var area: Double { get }
    func scaled(by factor: Double) -> Self
}

public struct Circle: Shape, Hashable {
    public typealias Unit = Double
    public var radius: Double
    public var area: Double { .pi * radius * radius }

    public init(radius: Double) {
        self.radius = radius
    }

    public func scaled(by factor: Double) -> Circle {
        Circle(radius: radius * factor)
    }
}

public enum Token: Equatable {
    case number(Int)
    case word(String)
    case pair(left: Int, right: Int)
    indirect case nested(Token)
}

@propertyWrapper
public struct Clamped<Value: Comparable> {
    private var value: Value
    private let range: ClosedRange<Value>

    public init(wrappedValue: Value, _ range: ClosedRange<Value>) {
        self.range = range
        self.value = min(max(wrappedValue, range.lowerBound), range.upperBound)
    }

    public var wrappedValue: Value {
        get { value }
        set { value = min(max(newValue, range.lowerBound), range.upperBound) }
    }
}

@resultBuilder
public enum ListBuilder {
    public static func buildBlock(_ parts: [String]...) -> [String] {
        parts.flatMap { $0 }
    }
    public static func buildExpression(_ line: String) -> [String] { [line] }
    public static func buildOptional(_ part: [String]?) -> [String] { part ?? [] }
    public static func buildEither(first part: [String]) -> [String] { part }
    public static func buildEither(second part: [String]) -> [String] { part }
}

public func list(@ListBuilder _ content: () -> [String]) -> [String] {
    content()
}

public final class Counter: @unchecked Sendable {
    @Clamped(0...100) public var level = 50
    private var total = 0 {
        willSet { print("will", newValue) }
        didSet { print("did", oldValue, total) }
    }
    private let lock = NSLock()
    nonisolated(unsafe) static var shared = Counter()
    unowned(unsafe) var owner: AnyObject?
    weak var delegate: AnyObject?
    lazy var label: String = "counter \(total)"

    public subscript(index: Int) -> Int {
        get { total + index }
        set(next) { total = next - index }
    }

    @discardableResult
    public func add(_ amount: Int, times count: Int = 1) -> Int {
        lock.lock()
        defer { lock.unlock() }
        for _ in 0..<count {
            total += amount
        }
        return total
    }

    deinit {
        print("gone")
    }
}

public actor Bank {
    private var balances: [String: Int] = [:]

    public func deposit(_ amount: Int, to account: String) async {
        balances[account, default: 0] += amount
    }

    public func balance(of account: String) -> Int {
        balances[account] ?? 0
    }
}

@MainActor
public final class ViewModel {
    @available(macOS 14, *)
    public var title = "Title"
    private var items: [Circle] = []

    public func load(from url: URL, bank: Bank) async throws -> Int {
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let text = String(decoding: data, as: UTF8.self)
        await bank.deposit(text.count, to: "main")
        let total = await bank.balance(of: "main")
        return total
    }

    public func sorted() -> [Circle] {
        let byArea = items.sorted { $0.area < $1.area }
        let names = items.map { circle in "r=\(circle.radius)" }
        let doubled = items.map { (c: Circle) -> Circle in c.scaled(by: 2) }
        _ = names.filter { name in name.count > 3 }
        _ = doubled
        return byArea
    }

    public func capture(_ handler: @escaping @Sendable (Int) -> Void) {
        Task { [weak self] in
            guard let self else { return }
            let count = self.items.count
            handler(count)
        }
    }
}

public func describe(_ token: Token) -> String {
    switch token {
    case .number(let n) where n < 0:
        return "negative \(n)"
    case .number(let n):
        return "number \(n)"
    case let .word(w):
        return "word \(w.uppercased())"
    case .pair(left: let l, right: var r):
        r += l
        return "pair \(l) \(r)"
    case .nested(let inner):
        return describe(inner)
    }
}

public func parse(_ input: String?) throws -> Int {
    guard let input, !input.isEmpty else { return 0 }
    if let value = Int(input) {
        return value
    }
    let forced = Int(input)!
    let any: Any = forced
    let cast = any as! Int
    let maybe = any as? String
    let attempt = try? JSONSerialization.jsonObject(with: Data())
    _ = (maybe, attempt)
    return cast
}

public func strings(name: String, count: Int) -> [String] {
    let simple = "Hello, \(name)! You have \(count + 1) items"
    let nested = "outer \("inner \(name)") done"
    let raw = #"raw \(name) stays, \#(name) interpolates"#
    let rawer = ##"a "#quote"# inside"##
    let multi = """
        Dear \(name),
          count: \(count)
        "quoted" and \"""
        """
    let rawMulti = #"""
        raw block \#(count) and \(literal)
        """#
    let escaped = "tab\tnewline\nunicode\u{1F600}"
    return [simple, nested, raw, rawer, multi, rawMulti, escaped]
}

public func regexes(_ line: String) -> Int {
    let digits = #/\d+/#
    let words = #/(?<word>[a-z]+)\s*/#
    let extended = #/
        (?<key> \w+ ) \s* = \s* (?<value> .+ )
        /#
    var hits = 0
    if line.contains(digits) { hits += 1 }
    if let match = line.firstMatch(of: words) {
        hits += match.output.word.count
    }
    if let kv = line.wholeMatch(of: extended) {
        hits += kv.output.key.count
    }
    let ratio = 10 / 2 / 5
    return hits + ratio
}

public func unsafeWork(_ values: [UInt8]) -> UInt8 {
    var copy = values
    let sum = copy.withUnsafeMutableBufferPointer { buffer -> UInt8 in
        var acc: UInt8 = 0
        for i in buffer.indices {
            acc &+= buffer[i]
        }
        return acc
    }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: 8, alignment: 8)
    defer { raw.deallocate() }
    let typed: UnsafeMutablePointer<UInt8> = raw.bindMemory(to: UInt8.self, capacity: 8)
    typed.pointee = sum
    let bits = unsafeBitCast(sum, to: Int8.self)
    return typed.pointee &+ UInt8(bitPattern: bits)
}

public func loops(_ grid: [[Int]]) -> Int {
    var found = 0
    outer: for row in grid {
        for cell in row where cell > 0 {
            if cell == 99 { break outer }
            if cell == 7 { continue outer }
            found += cell
        }
    }
    var i = 0
    while i < 3 { i += 1 }
    repeat { i -= 1 } while i > 0
    switch found {
    case 0:
        fallthrough
    case 1...9:
        found *= 2
    default:
        break
    }
    let kind = if found > 10 { "big" } else { "small" }
    let sign = switch found { case ..<0: -1; case 0: 0; default: 1 }
    _ = (kind, sign)
    return found
}

public func modify(_ value: inout Int, by step: Int) {
    value += step
}

public func generic<T: Comparable, U>(_ a: T, _ b: T, map: (T) -> U) -> U where U: CustomStringConvertible {
    map(max(a, b))
}

public func opaque() -> some Shape { Circle(radius: 1) }
public func existential() -> any Shape { Circle(radius: 2) }

public func keyPaths(_ items: [Circle]) -> [Double] {
    let path = \Circle.radius
    return items.map(\.area) + items.map { $0[keyPath: path] }
}

public func errors() {
    do {
        _ = try parse("x")
    } catch let error as NSError {
        print(error.code)
    } catch {
        print(error.localizedDescription)
    }
    let `default` = 3
    print(`default`, #file, #line, #function)
}

extension Circle: CustomStringConvertible {
    public var description: String { "Circle(\(radius))" }
}

#if os(macOS)
let platformName = "macOS"
#elseif os(iOS)
let platformName = "iOS"
#else
#warning("unknown platform")
let platformName = "other"
#endif

public func availability() -> String {
    if #available(macOS 14, *) {
        return "new"
    }
    return platformName
}

public struct Logger {
    let log = os.Logger(subsystem: "x", category: "y")
    public func write(_ message: String, code: Int) {
        log.info("message \(message, privacy: .public) code \(code)")
        print(String(format: "%@ has %d items, %.2f%%", message, code, 0.5))
    }
}

public func pack<each T>(_ values: repeat each T) -> (repeat each T) {
    (repeat each values)
}

public func ownership(_ name: consuming String, _ other: borrowing String) -> String {
    let copy = consume name
    return copy + copy other
}
