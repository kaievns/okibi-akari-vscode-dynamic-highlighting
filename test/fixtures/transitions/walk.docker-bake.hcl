// A Bake file with self, this, async and numbers.
variable "TAG" {
  default = "self"
}
function "tag" {
  params = [name, this]
  result = ["example/${name}:${this}"]
}
target "app" {
  tags = tag("async", TAG)
  args = {
    RETRIES = 3
    HEAP    = 0x10 * 1.5e3
    SELF    = "this"
  }
  matrix = {
    mode = ["async", "sync"]
  }
  name = "app-${mode}"
}
