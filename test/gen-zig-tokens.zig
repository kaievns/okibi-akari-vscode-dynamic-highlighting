// Zig's own tokenizer over one file, as the `[tag, start, end]` list
// test/zig.test.js compares the lexer with (byte offsets: keep the sample ASCII):
//   zig run test/gen-zig-tokens.zig -- samples/sample.zig > test/fixtures/sample.zig.tokens.json
const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const io = init.io;
    const args = try init.minimal.args.toSlice(arena);
    var out_buf: [1 << 16]u8 = undefined;
    var fw: std.Io.File.Writer = .init(.stdout(), io, &out_buf);
    const w = &fw.interface;
    const src = try std.Io.Dir.cwd().readFileAllocOptions(io, args[1], arena, .unlimited, .of(u8), 0);
    var t = std.zig.Tokenizer.init(src);
    var first = true;
    try w.writeAll("[");
    while (true) {
        const tok = t.next();
        if (tok.tag == .eof) break;
        try w.print("{s}[\"{s}\",{d},{d}]", .{ if (first) "" else ",", @tagName(tok.tag), tok.loc.start, tok.loc.end });
        first = false;
    }
    try w.writeAll("]\n");
    try w.flush();
}
