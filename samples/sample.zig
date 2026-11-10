//! Container doc: a synthetic tour of Zig for the companion.
//! It uses `const`, braces { } and "quotes" inside doc text.

const std = @import("std");
const builtin = @import("builtin");
const mem = std.mem;
const Allocator = std.mem.Allocator;
const c = @import("c.zig");

pub const version: u32 = 0x1F;
pub var counter: usize = 0;
threadlocal var tls_depth: u8 = 0;
export var exported_flag: bool = false;
extern "c" fn abs(x: c_int) c_int;
var section_word: u32 linksection(".data") = 0b1010_1010;

/// A point with doc comments.
pub const Point = struct {
    x: f32 = 0.0,
    y: f32 = 1e3,

    const Self = @This();

    /// Length of the vector.
    pub fn len(self: Self) f32 {
        return @sqrt(self.x * self.x + self.y * self.y);
    }

    pub fn scale(self: *Self, k: f32) void {
        self.x *= k;
        self.y *= k;
    }
};

pub const Color = enum(u8) { red, green, blue = 0o17, _ };

const Flags = packed struct(u8) {
    a: bool,
    b: bool,
    rest: u6 = 0,
};

const CHeader = extern struct { tag: c_int, len: usize };

const Value = union(enum) {
    int: i64,
    float: f64,
    text: []const u8,
    none,
};

const Bare = union { a: u32, b: f32 };
const Handle = opaque {};

const ParseError = error{ InvalidChar, Overflow };
const AppError = ParseError || error{OutOfMemory};

fn List(comptime T: type) type {
    return struct {
        items: []T,
        len: usize = 0,

        const Self = @This();

        pub fn first(self: Self) ?T {
            if (self.len == 0) return null;
            return self.items[0];
        }
    };
}

fn maxOf(comptime T: type, a: T, b: T) T {
    return if (a > b) a else b;
}

fn describe(writer: anytype, value: anytype) !void {
    try writer.print("{any}\n", .{value});
}

fn parseDigit(ch: u8) ParseError!u8 {
    return switch (ch) {
        '0'...'9' => ch - '0',
        'a', 'b' => error.InvalidChar,
        else => error.Overflow,
    };
}

fn sumAll(values: []const Value, total: *f64) usize {
    var seen: usize = 0;
    for (values, 0..) |v, i| {
        switch (v) {
            .int => |n| total.* += @floatFromInt(n),
            .float => |f| total.* += f,
            .text => |s| {
                seen += s.len + i;
            },
            .none => {},
        }
    }
    return seen;
}

fn bump(v: *Value) void {
    switch (v.*) {
        .int => |*n| n.* += 1,
        .float => |*f| f.* *= 2.0,
        else => unreachable,
    }
}

fn findIndex(haystack: []const u8, needle: u8) ?usize {
    var i: usize = 0;
    while (i < haystack.len) : (i += 1) {
        if (haystack[i] == needle) return i;
    } else {
        return null;
    }
}

fn labelled(n: u32) u32 {
    const v = blk: {
        var acc: u32 = 0;
        var k: u32 = 0;
        outer: while (k < n) : (k += 1) {
            for (0..n) |j| {
                if (j == 3) continue :outer;
                if (acc > 100) break :outer;
                acc += @intCast(j);
            }
        }
        break :blk acc;
    };
    return v;
}

fn inlineFields(comptime T: type, value: T) usize {
    var total: usize = 0;
    inline for (std.meta.fields(T)) |field| {
        total += @sizeOf(field.type);
        _ = @field(value, field.name);
    }
    comptime var depth = 0;
    inline while (depth < 2) : (depth += 1) {
        total += depth;
    }
    return total;
}

fn allocDemo(allocator: Allocator) ![]u8 {
    const buf = try allocator.alloc(u8, 16);
    errdefer allocator.free(buf);
    defer counter += 1;
    @memset(buf, 'z');
    const maybe = findIndex(buf, 'z') orelse return error.OutOfMemory;
    _ = maybe;
    const n = parseDigit('7') catch |err| {
        std.debug.print("bad digit: {s}\n", .{@errorName(err)});
        return err;
    };
    _ = n;
    return buf;
}

fn pointers(raw: [*]u8, len: usize, sentinel: [:0]const u8, arr: *const [4]u8) u8 {
    const slice: []u8 = raw[0..len];
    var many: [*c]u8 = @ptrCast(raw);
    many += 1;
    const addr = @intFromPtr(raw);
    const aligned: *align(4) u32 = @ptrCast(@alignCast(raw));
    const mutable: *u8 = @constCast(&arr[0]);
    mutable.* = 9;
    aligned.* = @truncate(addr);
    _ = sentinel[0];
    return slice[0] + arr[1];
}

fn literals() void {
    const greeting =
        \\Hello, "world" with {braces}
        \\  and a // not-a-comment line
        \\ and an x variable
    ;
    const ch = 'a';
    const emoji = '\u{1F600}';
    const esc = '\'';
    const hex = 0xFF_FF;
    const oct = 0o755;
    const bin = 0b1100;
    const big = 1_000_000;
    const exp = 1e3;
    const hexf = 0x1.8p3;
    const pt = Point{ .x = 1, .y = 2 };
    const anon = .{ .x = 1, .name = "anon" };
    const tuple = .{ 1, "two", 3.0 };
    const color: Color = .green;
    const line: u32 = 7;
    const @"while" = 5;
    var @"quoted name": u32 = 0;
    @"quoted name" += @"while";
    std.debug.print("{s} {c} {u} {d} {o} {b} {d:.2} {x:0>2} {} {any} {{literal}}\n", .{ greeting, ch, emoji, hex, oct, bin, exp, big, hexf, pt });
    std.debug.print("{} {} {} {} {}\n", .{ anon.x, tuple[0], color, esc, line });
    const msg = std.fmt.comptimePrint("v{d}.{d}", .{ 1, 2 });
    _ = msg;
    const undef: u32 = undefined;
    _ = undef;
}

fn banner(width: usize) void {
    const text =
        \\width and text inside a string
        \\{d} more {s}
    ;
    std.debug.print(text, .{ width, text });
}

fn conv(x: i64) u8 {
    const small: u8 = @intCast(x);
    const wide = @as(u64, small);
    const f: f32 = @floatFromInt(wide);
    const back: i32 = @intFromFloat(f);
    if (back < 0) @panic("negative");
    return small;
}

fn noisy() callconv(.c) void {
    asm volatile ("nop");
}

comptime {
    if (builtin.mode == .ReleaseSmall and @sizeOf(usize) < 4) {
        @compileError("unsupported target");
    }
}

test "point length" {
    const p = Point{ .x = 3, .y = 4 };
    try std.testing.expectEqual(@as(f32, 5), p.len());
}

test "sum all values" {
    var total: f64 = 0;
    const vals = [_]Value{ .{ .int = 1 }, .{ .float = 2.5 }, .{ .text = "abc" }, .none };
    const seen = sumAll(&vals, &total);
    try std.testing.expect(seen > 0 and total == 3.5);
    var list: List(u8) = .{ .items = &.{}, .len = 0 };
    try std.testing.expect(list.first() == null);
    list.len = 0;
    _ = maxOf(u8, 1, 2);
    _ = inlineFields(Point, .{});
    _ = labelled(4);
    _ = conv(3);
    banner(4);
    literals();
    var b = Value{ .int = 1 };
    bump(&b);
    var flag_set: Flags = .{ .a = true, .b = false };
    flag_set.rest = 3;
    _ = Bare{ .a = 1 };
    _ = @as(?*Handle, null);
    _ = CHeader{ .tag = 0, .len = 0 };
    _ = abs;
    _ = c;
    _ = noisy;
    tls_depth += 1;
    exported_flag = !exported_flag;
    section_word ^= 1;
    _ = AppError;
    try describe(std.io.null_writer, flag_set);
    _ = pointers;
    _ = allocDemo;
    _ = mem;
}
