// walk.h — an Objective-C header, which opens as cpp
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@protocol CacheDelegate <NSObject>
- (void)cache:(id)cache didEvict:(NSUInteger)count;
@end

@interface Cache : NSObject {
    NSUInteger _hits;
}
/// The limit, see @c limit.
@property (nonatomic) NSUInteger limit; // zero is unbounded
@property (nonatomic, weak, nullable) id<CacheDelegate> delegate;
- (instancetype)initWithLimit:(NSUInteger)limit NS_DESIGNATED_INITIALIZER;
- (void)storeObject:(id)object forKey:(NSString *)key cost:(NSUInteger)cost;
- (nullable id)objectForKey:(NSString *)key;
- (void)enumerate:(void (^)(NSString *key, BOOL *stop))block;
@end

static inline NSUInteger CacheCost(NSString *key, NSUInteger base) {
    NSUInteger cost = base + key.length;
    void *raw = (void *)key;
    return raw ? cost : 0;
}

NS_ASSUME_NONNULL_END
