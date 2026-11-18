#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, WidgetState) {
    WidgetStateIdle,
    WidgetStateBusy,
};

@protocol WidgetDelegate <NSObject>
- (void)widget:(id)widget didChangeState:(WidgetState)state;
@optional
- (BOOL)widgetShouldReload:(id)widget;
@end

@interface Widget : NSObject <NSCopying>

@property (nonatomic, copy) NSString *name;
@property (nonatomic, assign, readonly) NSInteger count;
@property (nonatomic, weak, nullable) id<WidgetDelegate> delegate;
@property (nonatomic, strong) NSMutableArray<NSString *> *items;
@property (class, nonatomic, readonly) Widget *sharedWidget;

- (instancetype)initWithName:(NSString *)name count:(NSInteger)count NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;
+ (instancetype)widgetWithName:(NSString *)name;
- (void)addItem:(NSString *)item atIndex:(NSUInteger)index;
- (void)loadWithCompletion:(void (^)(NSArray<NSString *> *results, NSError *_Nullable error))completion;

@end

NS_ASSUME_NONNULL_END
