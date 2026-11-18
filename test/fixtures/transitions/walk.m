#import "Widget.h"

static NSInteger instanceCount = 0;

@implementation Widget {
    NSInteger _generation;
}

- (instancetype)initWithName:(NSString *)name count:(NSInteger)count {
    self = [super init];
    if (self) {
        _name = [name copy];
        _count = count;
        instanceCount += 1;
    }
    return self;
}

- (void)addItem:(NSString *)item atIndex:(NSUInteger)index {
    if (index > self.items.count) {
        @throw [NSException exceptionWithName:NSRangeException reason:@"index" userInfo:nil];
    }
    [self.items insertObject:item atIndex:index];
}

- (void)bridging {
    CFStringRef ref = (__bridge CFStringRef)self.name;
    NSString *back = (__bridge_transfer NSString *)CFStringCreateCopy(NULL, ref);
    SEL selector = NSSelectorFromString(@"reload");
    [self performSelector:selector withObject:back];
    NSLog(@"%@ %lu", back, (unsigned long)self.items.count);
}

- (NSInteger)sumUpTo:(NSInteger)limit {
    NSInteger total = 0;
    for (NSInteger i = 0; i < limit; i++) {
        total += i;
    }
    int (^square)(int) = ^int(int value) {
        return value * value;
    };
    return total + square(3);
}

- (BOOL)settle {
    __weak typeof(self) weakSelf = self;
    __block BOOL done = NO;
    [self.items enumerateObjectsUsingBlock:^(id obj, NSUInteger idx, BOOL *stop) {
        done = obj != nil && weakSelf != nil;
        *stop = done ? YES : NO;
    }];
    return done;
}

@end
