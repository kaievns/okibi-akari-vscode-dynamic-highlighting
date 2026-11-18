#import "Widget.h"
#import <objc/runtime.h>

static NSString *const WidgetErrorDomain = @"WidgetErrorDomain";
static NSInteger instanceCount = 0;

@interface Widget ()
@property (nonatomic, assign, readwrite) NSInteger count;
@end

@implementation Widget {
    NSInteger _generation;
    dispatch_queue_t _queue;
}

@synthesize count = _count;

- (instancetype)initWithName:(NSString *)name count:(NSInteger)count {
    self = [super init];
    if (self) {
        _name = [name copy];
        _count = count;
        _items = [NSMutableArray array];
        _queue = dispatch_queue_create("widget", DISPATCH_QUEUE_SERIAL);
        instanceCount += 1;
    }
    return self;
}

+ (instancetype)widgetWithName:(NSString *)name {
    return [[self alloc] initWithName:name count:0];
}

+ (Widget *)sharedWidget {
    static Widget *shared = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        shared = [[Widget alloc] initWithName:@"shared" count:1];
    });
    return shared;
}

- (id)copyWithZone:(NSZone *)zone {
    Widget *copy = [[[self class] allocWithZone:zone] initWithName:self.name count:self.count];
    copy->_generation = _generation + 1;
    return copy;
}

- (void)addItem:(NSString *)item atIndex:(NSUInteger)index {
    if (index > self.items.count) {
        @throw [NSException exceptionWithName:NSRangeException reason:@"index" userInfo:nil];
    }
    [self.items insertObject:item atIndex:index];
    self.count = (NSInteger)self.items.count;
    [self.delegate widget:self didChangeState:WidgetStateBusy];
}

- (void)loadWithCompletion:(void (^)(NSArray<NSString *> *results, NSError *_Nullable error))completion {
    __weak typeof(self) weakSelf = self;
    dispatch_async(_queue, ^{
        __strong typeof(weakSelf) strongSelf = weakSelf;
        if (!strongSelf) {
            return;
        }
        NSMutableArray<NSString *> *results = [NSMutableArray arrayWithCapacity:strongSelf.items.count];
        for (NSString *item in strongSelf.items) {
            NSString *line = [NSString stringWithFormat:@"%@: %ld (%.2f%%)", item, (long)strongSelf.count, 12.5];
            [results addObject:line];
        }
        NSError *error = nil;
        if (results.count == 0) {
            error = [NSError errorWithDomain:WidgetErrorDomain code:1 userInfo:@{NSLocalizedDescriptionKey: @"empty"}];
        }
        completion(results, error);
    });
}

- (void)bridging {
    CFStringRef ref = (__bridge CFStringRef)self.name;
    NSString *back = (__bridge_transfer NSString *)CFStringCreateCopy(NULL, ref);
    CFTypeRef retained = (__bridge_retained CFTypeRef)back;
    CFRelease(retained);
    SEL selector = NSSelectorFromString(@"reload");
    if ([self respondsToSelector:selector]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
        [self performSelector:selector withObject:nil];
#pragma clang diagnostic pop
    }
    objc_setAssociatedObject(self, @selector(bridging), @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    NSArray *numbers = @[@1, @2.5, @YES];
    NSDictionary *map = @{@"key": @"value", @"n": @(numbers.count)};
    id unknown = map[@"key"];
    NSString *forced = (NSString *)unknown;
    NSLog(@"%@ %@ %lu", forced, numbers, (unsigned long)map.count);
}

- (NSInteger)sumUpTo:(NSInteger)limit {
    NSInteger total = 0;
    for (NSInteger i = 0; i < limit; i++) {
        if (i % 2 == 0) {
            continue;
        }
        total += i;
    }
    int (^square)(int) = ^int(int value) {
        return value * value;
    };
    total += square(3);
    @try {
        [self addItem:@"x" atIndex:99];
    } @catch (NSException *exception) {
        NSLog(@"%@", exception.reason);
    } @finally {
        _generation++;
    }
    @synchronized (self) {
        total -= 1;
    }
    @autoreleasepool {
        total += [@"abc" length];
    }
    return total;
}

@end
