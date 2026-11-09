pub const MAX_RETRIES: u32 = 3;

/// Retries `count` times, up to [`MAX_RETRIES`].
///
/// ```
/// let count = 2;
/// let total = rsrepro::retry(count);
/// assert_eq!(total, count + 1);
/// ```
pub fn retry(count: u32) -> u32 {
    // count is bumped by 1 here, see MAX_RETRIES
    let total = count + 1;
    /* total as any */
    total
}
