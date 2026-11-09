---@param mode "short"|"long"
---@return string
local function label(mode, n)
  return string.format("%s: %5.2f%% of %-3d", mode, n, 100)
end

local a = string.format('%x items', 255)
local b = ("%s=%s"):format("k", "v")
local c = ([[%d of %d]]):format(1, 2)
local d = string.format(
  "%d split %s",
  3, "lines"
)
local e = string.format([==[%q done]==], "x")
local f = string.format("\\%s \65%i", 1, 2)
local g = ('%d'):format(5) .. string.format ( "%c", 65 )

local pattern = string.gsub("abc", "%w", "%0%0")
local m = ("%d"):match("%d")
local other = self.string.format("%d", 1)
local later = string.format(label, "%d")
local open = string.format( -- a trailing comment
  "%d", 1)
-- string.format("%d", 1) in a comment
local s = [[ string.format("%d", 1) in a long string ]]
local after = string.format(
  -- a comment line first
  "%d", 1)
return label, a, b, c, d, e, f, g, pattern, m, other, later, open, s, after
