--- Module docs: every construct the companion has to read.
-- @module usecases
local M = {}

local fmt = require("string")
local json = require "dkjson"
local util <const> = require("lib.util")
local MAX_RETRIES <const> = 3

counter = 0 -- a global
M.version = "1.0"

---@class Point
---@field x number
---@field y number
local Point = {}
Point.__index = Point

---Make a point.
---@param x number the x
---@param y number the y
---@return Point
function Point.new(x, y)
  local self = setmetatable({}, Point)
  self.x = x
  self.y = y
  return self
end

function Point:len()
  return math.sqrt(self.x * self.x + self.y * self.y)
end

function Point:scale(k)
  local factor = k or 1
  self.x = self.x * factor
  self.y = self.y * factor
  return self
end

local function sum(...)
  local total = 0
  for i = 1, select("#", ...) do
    local v = select(i, ...)
    total = total + v
  end
  return total
end

local function encode(value)
  return json.encode({ value = value, at = util.now() })
end

local function counter_factory()
  local count = 0
  return function(step)
    count = count + (step or 1)
    counter = counter + 1
    return count
  end
end

local function walk(list, visit)
  for index, item in ipairs(list) do
    if item == nil then
      goto continue
    elseif type(item) == "table" then
      walk(item, visit)
    else
      visit(index, item)
    end
    ::continue::
  end
  local n = #list
  while n > 0 do
    n = n - 1
    if n % 2 == 0 then break end
  end
  repeat
    local left = n
    n = left + 1
  until n >= 3
  do
    local scoped = n * 2
    M.last = scoped
  end
end

local config = {
  name = "demo",
  ["key with space"] = true,
  nested = { depth = 2, list = { 1, 2, 3 } },
  on_attach = function(client, bufnr)
    local opts = { buffer = bufnr, silent = true }
    vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
    client.server_capabilities.documentFormattingProvider = false
  end,
}

local long = [[
a long string with "quotes" and -- not a comment
]]
local level = [==[
it holds ]] and ]=] inside
]==]

--[[ a long comment
local hidden = 1
]]

--[==[
another long comment with ]] inside
]==]

local escapes = "tab\t nl\n quote\" hex\x41 dec\65 unicode\u{2603} skip\z
      continued"
local single = 'it\'s'
local hexf = 0x1p4 + 0xA.8p-1 + 1e10 + 3.14 + .5 + 0xff + 1//2
local s = string.format("%d items, %5.2f%% done, %s, %q, %-10s|%x", 3, 99.5, "ok", "q", "pad", 255)
local str_ops = ("abc"):upper() .. ("x"):rep(3)
local neq = (1 ~= 2) and not false or nil
local bits = 5 & 3 | 2 ~ 1 << 2 >> 1

local file <close> = io.open("/dev/null")
local t = table.concat({ "a", "b" }, ",")
local co = coroutine.wrap(function() coroutine.yield(1) end)
local ok, err = pcall(error, "boom")
os.exit = os.exit
utf8.char(72)
debug.traceback()
package.path = package.path .. ";./?.lua"

local mt = setmetatable({}, {
  __index = function(tbl, key) return rawget(tbl, key) end,
  __newindex = function(tbl, key, value) rawset(tbl, key, value) end,
  __call = function(self, ...) return sum(...) end,
})

-- self in a comment, and a self.x = 1 that is prose
local type = config.name
if type == "demo" then print(type) end

M.walk = walk
M.sum = sum
M.encode = encode
M.counter_factory = counter_factory
return M

