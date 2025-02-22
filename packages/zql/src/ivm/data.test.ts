import {compareUTF8} from 'compare-utf8';
import fc from 'fast-check';
import {expect, test} from 'vitest';
import {
  compareValues,
  makeComparator,
  normalizeUndefined,
  valuesEqual,
} from './data.ts';
import {compareRowsTest} from './test/compare-rows-test.ts';

test('normalizeUndefined', () => {
  fc.assert(
    fc.property(fc.constantFrom(null, undefined), v => {
      expect(normalizeUndefined(v)).toBe(null);
    }),
  );
  fc.assert(
    fc.property(fc.oneof(fc.boolean(), fc.double(), fc.string()), b => {
      expect(normalizeUndefined(b)).toBe(b);
    }),
  );
});

test('compareValues', () => {
  // null and undefined are equal to each other
  fc.assert(
    fc.property(
      fc.constantFrom(null, undefined),
      fc.constantFrom(null, undefined),
      (v1, v2) => {
        expect(compareValues(v1, v2)).toBe(0);
      },
    ),
  );

  // null and undefined are less than any other value
  fc.assert(
    fc.property(
      fc.constantFrom(null, undefined),
      fc.oneof(fc.boolean(), fc.double(), fc.fullUnicodeString()),
      (v1, v2) => {
        expect(compareValues(v1, v2)).lessThan(0);
        expect(compareValues(v2, v1)).greaterThan(0);
      },
    ),
  );

  // boolean
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), (b1, b2) => {
      expect(compareValues(b1, b2)).toBe(b1 === b2 ? 0 : b1 ? 1 : -1);
    }),
  );
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.oneof(fc.double(), fc.fullUnicodeString()),
      (b, v) => {
        expect(() => compareValues(b, v)).toThrow('expected boolean');
      },
    ),
  );

  // number
  fc.assert(
    fc.property(fc.double(), fc.double(), (n1, n2) => {
      expect(compareValues(n1, n2)).toBe(n1 - n2);
    }),
  );
  fc.assert(
    fc.property(
      fc.double(),
      fc.oneof(fc.boolean(), fc.fullUnicodeString()),
      (n, v) => {
        expect(() => compareValues(n, v)).toThrow('expected number');
      },
    ),
  );

  // string
  fc.assert(
    fc.property(fc.fullUnicodeString(), fc.fullUnicodeString(), (s1, s2) => {
      expect(compareValues(s1, s2)).toBe(compareUTF8(s1, s2));
    }),
  );
  fc.assert(
    fc.property(
      fc.fullUnicodeString(),
      fc.oneof(fc.boolean(), fc.double()),
      (s, v) => {
        expect(() => compareValues(s, v)).toThrow('expected string');
      },
    ),
  );
});

test('valuesEquals', () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.boolean(), fc.double(), fc.fullUnicodeString()),
      fc.oneof(fc.boolean(), fc.double(), fc.fullUnicodeString()),
      (v1, v2) => {
        expect(valuesEqual(v1, v2)).toBe(v1 === v2);
      },
    ),
  );

  fc.assert(
    fc.property(
      fc.constantFrom(null, undefined),
      fc.oneof(
        fc.constantFrom(null, undefined),
        fc.boolean(),
        fc.double(),
        fc.fullUnicodeString(),
      ),
      (v1, v2) => {
        expect(valuesEqual(v1, v2)).false;
        expect(valuesEqual(v2, v1)).false;
      },
    ),
  );
});

test('comparator', () => {
  compareRowsTest(makeComparator);
});
