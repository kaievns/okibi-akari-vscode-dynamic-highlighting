local json = require("dkjson")
local Queue = {}
Queue.__index = Queue

--[[ A queue of jobs.
local hidden = 1
]]

function Queue.new(size)
  local self = setmetatable({}, Queue)
  self.size = size
  self.items = {}
  return self
end

function Queue:push(job, type)
  if #self.items >= self.size then
    return false
  elseif type == "urgent" then
    table.insert(self.items, 1, job)
  else
    self.items[#self.items + 1] = job
  end
  pushed = (pushed or 0) + 1
  return true
end

local function drain(queue, visit)
  local count = 0
  local text = [[
  not code: local x = 1
  ]]
  for index, job in ipairs(queue.items) do
    repeat
      local ok = visit(index, job)
      count = count + 1
    until ok
  end
  queue.items = {}
  return count, json.encode({ n = count, text = text })
end

local summary = string.format("%d jobs, %5.2f%% done", 3, 1.5)
return { Queue = Queue, drain = drain, opts = vim.opt, summary = summary }
