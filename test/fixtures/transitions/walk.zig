//! A queue of jobs, synthetic: every construct the walks need.
const std = @import("std");
const mem = std.mem;

pub var pushed_total: usize = 0;

pub const Queue = struct {
    items: []u32,
    size: usize = 0,

    const Self = @This();

    pub fn push(self: *Self, job: u32, priority: u32) usize {
        var pushed: usize = 0;
        for (self.items, 0..) |item, i| {
            if (item > priority) pushed += i;
        }
        self.size += 1;
        pushed_total += pushed;
        std.debug.print("pushed {d} of {d}, {{total}}\n", .{ pushed, job });
        return pushed + job;
    }
};

fn drain(q: *Queue, total: *u64) void {
    const label =
        \\draining {d} jobs, not code: total
    ;
    std.debug.print(label, .{q.size});
    while (q.size > 0) : (q.size -= 1) {
        const job = q.items[q.size - 1];
        total.* += job;
    }
}

fn count(lines: []const []const u8) usize {
    var n: usize = 0;
    const result = outer: {
        for (lines) |line| {
            if (mem.eql(u8, line, "end")) break :outer n;
            n += line.len;
        }
        break :outer n;
    };
    const raw: [*]const u8 = @ptrCast(lines.ptr);
    _ = raw;
    return result;
}

test "queue" {
    var q = Queue{ .items = &.{} };
    var total: u64 = 0;
    drain(&q, &total);
    _ = count(&.{ "a", "end" });
    _ = q.push(1, 2);
}
