package fixtures;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import static java.util.Objects.requireNonNull;

public class Constructs {

    static final int LIMIT = 10;
    private static int calls = 0;
    private final List<String> log = new ArrayList<>();
    private int seen;

    sealed interface Shape permits Circle, Square {}
    record Circle(double radius) implements Shape {}
    record Square(double side) implements Shape {}
    record Point(int x, int y) {}

    static {
        calls = 1;
    }

    {
        seen = 0;
    }

    public Constructs(int start) {
        this.seen = start;
        log.add("init");
    }

    static double area(Shape shape) {
        return switch (shape) {
            case Circle c -> Math.PI * c.radius() * c.radius();
            case Square s -> {
                double side = s.side();
                yield side * side;
            }
        };
    }

    static String describe(Object o) {
        if (o instanceof Point(int x, int y) && x > y) {
            return String.format("point %d > %d", x, y);
        }
        if (o instanceof String str && !str.isEmpty()) {
            return "string of %d chars".formatted(str.length());
        }
        return "other";
    }

    @SuppressWarnings("unchecked")
    List<String> unsafe(Object raw) {
        List<String> names = (List<String>) raw;
        Object any = names;
        String first = (String) ((List<?>) any).get(0);
        names.add(first);
        return names;
    }

    int scan(List<Integer> values) {
        int total = 0;
        outer:
        for (int i = 0; i < values.size(); i++) {
            for (var v : values) {
                if (v < 0) break outer;
                if (v == i) continue;
                total += v;
            }
        }
        seen += total;
        calls++;
        this.seen++;
        return total;
    }

    String read(String text) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (var reader = new BufferedReader(new StringReader(text))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line.trim());
            }
        } catch (IllegalStateException | IllegalArgumentException e) {
            throw new IOException("bad input: " + e.getMessage(), e);
        }
        return sb.toString();
    }

    static Map<String, Integer> counts(List<String> words, Function<String, Integer> weigh) {
        Map<String, Integer> out = new java.util.HashMap<>();
        words.forEach(w -> out.merge(w, weigh.apply(w), Integer::sum));
        words.stream().map(String::length).filter(n -> n > LIMIT).forEach(System.out::println);
        Runnable r = () -> System.out.println(out.size());
        r.run();
        new Thread(new Runnable() {
            @Override
            public void run() {
                int local = out.size();
                System.out.printf("%d words%n", local);
            }
        }).start();
        return requireNonNull(out);
    }

    String block() {
        String name = "x";
        String text = """
            Hello, %s!
              total: %d
            """.formatted(name, LIMIT);
        return text;
    }

    public static void main(String[] args) {
        var c = new Constructs(args.length);
        System.out.println(c.scan(List.of(1, 2, 3)) + area(new Circle(2.0)));
        System.out.println(describe(new Point(3, 1)));
    }
}
