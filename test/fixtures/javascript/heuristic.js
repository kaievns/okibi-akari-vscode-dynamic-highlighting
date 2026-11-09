const keyValues = args => {
  const out = []
  for (const a of args) out.push(a + args.length)
  return out
}
const pick = ({ name, size = 1 }, [first, second]) => {
  return name + size + first + second + name + size + first + second
}
const fs = require('fs')
const { join } = require('path')
const debug = require('debug')('x')
function load (p) {
  return fs.readFileSync(join(p, 'x')) + fs.statSync(p) + debug(p) + debug
}
const handler = async (req) => { return req.body + req.url }
function build () {
  const name = 1
  const opts = { name: name, size: 2, handler }
  outer: for (const k of [name]) { if (k) continue outer }
  return { name, size: opts.size + name }
}
