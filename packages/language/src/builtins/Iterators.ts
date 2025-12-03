export const iterators = `
type Iterator<U, V> = interface {
    fn hasNext() -> bool
    fn next() -> (U, V)
}

type Iterable<U, V> = interface {
    fn getIterator() -> Iterator<U, V>
}
`;