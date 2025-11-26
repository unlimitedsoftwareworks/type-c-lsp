export const stringPrototype = `
/**
 * @brief: String prototype.
 * Strings in type-c are encoded in UTF-8.
 * All operations preserve UTF-8 encoding and handle multi-byte characters correctly.
 */
prototype for string {
	// ============================================================
	// Core Properties & Access
	// ============================================================
	
	/**
	 * @brief: Returns the string length in terms of Unicode code points.
	 * This counts actual characters, not bytes.
	 * @return The number of Unicode characters in the string
	 * @example: "hello".length() -> 5
	 * @example: "🎉".length() -> 1 (even though it's 4 bytes)
	 */
	fn length() -> u64

	/**
	 * @brief: Returns the raw bytes length of the string.
	 * This is the actual memory size of the UTF-8 encoded string.
	 * @return The number of bytes in the string buffer
	 * @example: "hello".bytesLength() -> 5
	 * @example: "🎉".bytesLength() -> 4
	 */
	fn bytesLength() -> u64

	/**
	 * @brief: Returns the character at the given index.
	 * The character is returned as a UTF-8 encoded string.
	 * @param index: The zero-based index of the character
	 * @return A single-character string, or empty string if index out of bounds
	 * @example: "hello"[0] -> "h"
	 * @example: "hello".at(4) -> "o"
	 */
	fn at | [] (index: u64) -> string

	/**
	 * @brief: Returns the character at the given index, counting from the end.
	 * Negative indexing for convenient access to characters from the end.
	 * @param index: The index from the end (1-based for negative indexing)
	 * @return A single-character string, or empty string if index out of bounds
	 * @example: "hello"[-1] -> "o"
	 * @example: "hello".nat(1) -> "o"
	 * @example: "hello".nat(5) -> "h"
	 */
	fn nat | [-] (index: u64) -> string

	/**
	 * @brief: Returns the Unicode code point at the given index.
	 * @param index: The zero-based index of the character
	 * @return The Unicode code point value, or 0 if index out of bounds
	 * @example: "A".charCodeAt(0) -> 65
	 * @example: "🎉".charCodeAt(0) -> 127881
	 */
	fn charCodeAt(index: u64) -> u32

	/**
	 * @brief: Returns the raw byte buffer of the string.
	 * Provides direct access to the underlying UTF-8 bytes.
	 * @return Array of bytes representing the UTF-8 encoded string
	 */
	fn buffer() -> u8[]

	// ============================================================
	// Substring & Slicing
	// ============================================================

	/**
	 * @brief: Extracts a substring between two indices.
	 * @param start: The starting index (inclusive)
	 * @param end: The ending index (exclusive)
	 * @return A new string containing the extracted portion
	 * @example: "hello".substring(1, 4) -> "ell"
	 * @example: "hello".substring(0, 5) -> "hello"
	 */
	fn substring(start: u64, end: u64) -> string

	/**
	 * @brief: Extracts a substring from a starting index to the end.
	 * @param start: The starting index (inclusive)
	 * @return A new string from start to the end
	 * @example: "hello".substr(2) -> "llo"
	 */
	fn substr(start: u64) -> string

	/**
	 * @brief: Extracts a substring of specified length from a starting index.
	 * @param start: The starting index (inclusive)
	 * @param length: The number of characters to extract
	 * @return A new string with at most 'length' characters
	 * @example: "hello".substr(1, 3) -> "ell"
	 */
	fn substr(start: u64, length: u64) -> string

	/**
	 * @brief: Extracts a section of the string using slice semantics.
	 * Supports negative indices to count from the end.
	 * @param start: The starting index (inclusive, negative counts from end)
	 * @param end: The ending index (exclusive, negative counts from end)
	 * @return A new string containing the sliced portion
	 * @example: "hello".slice(1, 4) -> "ell"
	 * @example: "hello".slice(-2) -> "lo"
	 * @example: "hello".slice(1, -1) -> "ell"
	 */
	fn slice(start: i64, end: i64) -> string

	/**
	 * @brief: Extracts a section from a starting index to the end.
	 * @param start: The starting index (inclusive, negative counts from end)
	 * @return A new string from start to the end
	 * @example: "hello".slice(2) -> "llo"
	 * @example: "hello".slice(-2) -> "lo"
	 */
	fn slice(start: i64) -> string

	// ============================================================
	// Search & Testing
	// ============================================================

	/**
	 * @brief: Checks if the string starts with the given prefix.
	 * @param prefix: The prefix to check for
	 * @return true if the string starts with prefix, false otherwise
	 * @example: "hello world".startsWith("hello") -> true
	 * @example: "hello world".startsWith("world") -> false
	 */
	fn startsWith(prefix: string) -> bool

	/**
	 * @brief: Checks if the string starts with the given prefix at a position.
	 * @param prefix: The prefix to check for
	 * @param position: The position to start checking from
	 * @return true if the substring starting at position begins with prefix
	 * @example: "hello world".startsWith("world", 6) -> true
	 */
	fn startsWith(prefix: string, position: u64) -> bool

	/**
	 * @brief: Checks if the string ends with the given suffix.
	 * @param suffix: The suffix to check for
	 * @return true if the string ends with suffix, false otherwise
	 * @example: "hello world".endsWith("world") -> true
	 * @example: "hello world".endsWith("hello") -> false
	 */
	fn endsWith(suffix: string) -> bool

	/**
	 * @brief: Checks if the string ends with the given suffix before a length.
	 * @param suffix: The suffix to check for
	 * @param length: Treat the string as if it were this length
	 * @return true if the string (up to length) ends with suffix
	 * @example: "hello world".endsWith("hello", 5) -> true
	 */
	fn endsWith(suffix: string, length: u64) -> bool

	/**
	 * @brief: Checks if the string contains the given substring.
	 * @param substring: The substring to search for
	 * @return true if substring is found, false otherwise
	 * @example: "hello world".contains("lo wo") -> true
	 * @example: "hello world".contains("xyz") -> false
	 */
	fn contains(substring: string) -> bool

	/**
	 * @brief: Checks if the string contains the given substring starting at position.
	 * @param substring: The substring to search for
	 * @param position: The position to start searching from
	 * @return true if substring is found at or after position
	 * @example: "hello world".contains("world", 6) -> true
	 */
	fn contains(substring: string, position: u64) -> bool

	/**
	 * @brief: Finds the first occurrence of a substring.
	 * @param substring: The substring to search for
	 * @return The index of the first occurrence, or max u64 if not found
	 * @example: "hello world".indexOf("o") -> 4
	 * @example: "hello world".indexOf("xyz") -> max u64
	 */
	fn indexOf(substring: string) -> u64

	/**
	 * @brief: Finds the first occurrence of a substring starting at position.
	 * @param substring: The substring to search for
	 * @param position: The position to start searching from
	 * @return The index of the first occurrence at or after position
	 * @example: "hello world".indexOf("o", 5) -> 7
	 */
	fn indexOf(substring: string, position: u64) -> u64

	/**
	 * @brief: Finds the last occurrence of a substring.
	 * @param substring: The substring to search for
	 * @return The index of the last occurrence, or max u64 if not found
	 * @example: "hello world".lastIndexOf("o") -> 7
	 * @example: "hello world".lastIndexOf("xyz") -> max u64
	 */
	fn lastIndexOf(substring: string) -> u64

	/**
	 * @brief: Finds the last occurrence of a substring before position.
	 * @param substring: The substring to search for
	 * @param position: Search backwards from this position
	 * @return The index of the last occurrence at or before position
	 * @example: "hello world".lastIndexOf("o", 5) -> 4
	 */
	fn lastIndexOf(substring: string, position: u64) -> u64

	/**
	 * @brief: Checks if the string matches a regular expression pattern.
	 * @param pattern: The regex pattern to match against
	 * @return true if the string matches the pattern
	 * @example: "hello123".matches("[a-z]+[0-9]+") -> true
	 */
	fn matches(pattern: string) -> bool

	/**
	 * @brief: Searches for a regex pattern and returns the match.
	 * @param pattern: The regex pattern to search for
	 * @return The first matching substring, or empty string if no match
	 * @example: "hello123world".search("[0-9]+") -> "123"
	 */
	fn search(pattern: string) -> string

	// ============================================================
	// Replacement & Modification
	// ============================================================

	/**
	 * @brief: Replaces the first occurrence of a substring.
	 * @param oldS: The substring to replace
	 * @param newS: The replacement string
	 * @return A new string with the first occurrence replaced
	 * @example: "hello world".replaceFirst("o", "0") -> "hell0 world"
	 */
	fn replaceFirst(oldS: string, newS: string) -> string

	/**
	 * @brief: Replaces the last occurrence of a substring.
	 * @param oldS: The substring to replace
	 * @param newS: The replacement string
	 * @return A new string with the last occurrence replaced
	 * @example: "hello world".replaceLast("o", "0") -> "hello w0rld"
	 */
	fn replaceLast(oldS: string, newS: string) -> string

	/**
	 * @brief: Replaces the first occurrence of a substring (alias for replaceFirst).
	 * @param oldS: The substring to replace
	 * @param newS: The replacement string
	 * @return A new string with the first occurrence replaced
	 * @example: "hello world".replace("world", "universe") -> "hello universe"
	 */
	fn replace(oldS: string, newS: string) -> string

	/**
	 * @brief: Replaces all occurrences of a substring.
	 * @param oldS: The substring to replace
	 * @param newS: The replacement string
	 * @return A new string with all occurrences replaced
	 * @example: "hello world".replaceAll("o", "0") -> "hell0 w0rld"
	 */
	fn replaceAll(oldS: string, newS: string) -> string

	/**
	 * @brief: Replaces all matches of a regex pattern.
	 * @param pattern: The regex pattern to match
	 * @param newS: The replacement string
	 * @return A new string with all matches replaced
	 * @example: "hello123world456".replacePattern("[0-9]+", "X") -> "helloXworldX"
	 */
	fn replacePattern(pattern: string, newS: string) -> string

	// ============================================================
	// Case Transformation
	// ============================================================

	/**
	 * @brief: Converts all characters to lowercase.
	 * Handles Unicode case folding correctly.
	 * @return A new lowercase string
	 * @example: "Hello WORLD".toLowerCase() -> "hello world"
	 * @example: "ΣΟΦΙΑ".toLowerCase() -> "σοφια"
	 */
	fn toLowerCase() -> string

	/**
	 * @brief: Converts all characters to uppercase.
	 * Handles Unicode case folding correctly.
	 * @return A new uppercase string
	 * @example: "Hello World".toUpperCase() -> "HELLO WORLD"
	 * @example: "σοφια".toUpperCase() -> "ΣΟΦΙΑ"
	 */
	fn toUpperCase() -> string

	/**
	 * @brief: Converts the first character to uppercase, rest to lowercase.
	 * @return A new capitalized string
	 * @example: "hello world".capitalize() -> "Hello world"
	 * @example: "HELLO WORLD".capitalize() -> "Hello world"
	 */
	fn capitalize() -> string

	/**
	 * @brief: Converts the first character of each word to uppercase.
	 * Words are separated by whitespace.
	 * @return A new title-cased string
	 * @example: "hello world".toTitleCase() -> "Hello World"
	 * @example: "the quick brown fox".toTitleCase() -> "The Quick Brown Fox"
	 */
	fn toTitleCase() -> string

	/**
	 * @brief: Swaps the case of all characters.
	 * @return A new string with cases swapped
	 * @example: "Hello World".swapCase() -> "hELLO wORLD"
	 */
	fn swapCase() -> string

	// ============================================================
	// Trimming & Padding
	// ============================================================

	/**
	 * @brief: Removes whitespace from both ends of the string.
	 * @return A new string with leading and trailing whitespace removed
	 * @example: "  hello world  ".trim() -> "hello world"
	 * @example: "\t\nhello\n\t".trim() -> "hello"
	 */
	fn trim() -> string

	/**
	 * @brief: Removes whitespace from the start of the string.
	 * @return A new string with leading whitespace removed
	 * @example: "  hello world  ".trimStart() -> "hello world  "
	 */
	fn trimStart() -> string

	/**
	 * @brief: Removes whitespace from the end of the string.
	 * @return A new string with trailing whitespace removed
	 * @example: "  hello world  ".trimEnd() -> "  hello world"
	 */
	fn trimEnd() -> string

	/**
	 * @brief: Removes specified characters from both ends.
	 * @param chars: String containing characters to remove
	 * @return A new string with specified characters removed from both ends
	 * @example: "...hello...".trim(".") -> "hello"
	 * @example: "xxhelloxx".trim("x") -> "hello"
	 */
	fn trim(chars: string) -> string

	/**
	 * @brief: Removes specified characters from the start.
	 * @param chars: String containing characters to remove
	 * @return A new string with specified characters removed from start
	 * @example: "...hello...".trimStart(".") -> "hello..."
	 */
	fn trimStart(chars: string) -> string

	/**
	 * @brief: Removes specified characters from the end.
	 * @param chars: String containing characters to remove
	 * @return A new string with specified characters removed from end
	 * @example: "...hello...".trimEnd(".") -> "...hello"
	 */
	fn trimEnd(chars: string) -> string

	/**
	 * @brief: Pads the string to a target length from the start.
	 * @param targetLength: The desired total length
	 * @param padString: The string to pad with (default: " ")
	 * @return A new padded string
	 * @example: "5".padStart(3, "0") -> "005"
	 * @example: "hello".padStart(10, "*") -> "*****hello"
	 */
	fn padStart(targetLength: u64, padString: string) -> string

	/**
	 * @brief: Pads the string to a target length from the end.
	 * @param targetLength: The desired total length
	 * @param padString: The string to pad with (default: " ")
	 * @return A new padded string
	 * @example: "5".padEnd(3, "0") -> "500"
	 * @example: "hello".padEnd(10, "*") -> "hello*****"
	 */
	fn padEnd(targetLength: u64, padString: string) -> string

	// ============================================================
	// Splitting
	// ============================================================

	/**
	 * @brief: Splits the string by a separator.
	 * @param separator: The separator to split by
	 * @return Array of substrings
	 * @example: "hello,world,test".split(",") -> ["hello", "world", "test"]
	 * @example: "a-b-c".split("-") -> ["a", "b", "c"]
	 */
	fn split(separator: string) -> string[]

	/**
	 * @brief: Splits the string by a separator with a limit.
	 * @param separator: The separator to split by
	 * @param limit: Maximum number of splits to perform
	 * @return Array of at most (limit + 1) substrings
	 * @example: "a,b,c,d".split(",", 2) -> ["a", "b", "c,d"]
	 */
	fn split(separator: string, limit: u64) -> string[]

	/**
	 * @brief: Splits the string into lines.
	 * Handles \n, \r\n, and \r line endings.
	 * @return Array of lines
	 * @example: "hello\nworld\r\ntest".splitByLines() -> ["hello", "world", "test"]
	 */
	fn splitByLines() -> string[]

	/**
	 * @brief: Splits the string into words.
	 * Words are separated by whitespace (spaces, tabs, newlines).
	 * @return Array of words
	 * @example: "hello  world\ttest".splitByWords() -> ["hello", "world", "test"]
	 */
	fn splitByWords() -> string[]

	/**
	 * @brief: Splits the string into individual characters.
	 * Each character is a separate UTF-8 encoded string.
	 * @return Array of single-character strings
	 * @example: "hello".splitByChars() -> ["h", "e", "l", "l", "o"]
	 * @example: "🎉🎊".splitByChars() -> ["🎉", "🎊"]
	 */
	fn splitByChars() -> string[]

	/**
	 * @brief: Splits the string into individual bytes.
	 * Provides access to the raw UTF-8 byte sequence.
	 * @return Array of bytes
	 * @example: "hello".splitByBytes() -> [104, 101, 108, 108, 111]
	 */
	fn splitByBytes() -> u8[]

	/**
	 * @brief: Splits the string by a regex pattern.
	 * @param pattern: The regex pattern to split by
	 * @return Array of substrings
	 * @example: "hello123world456test".splitByPattern("[0-9]+") -> ["hello", "world", "test"]
	 */
	fn splitByPattern(pattern: string) -> string[]

	// ============================================================
	// Joining & Concatenation
	// ============================================================

	/**
	 * @brief: Concatenates this string with another.
	 * @param other: The string to concatenate
	 * @return A new concatenated string
	 * @example: "hello".cat(" world") -> "hello world"
	 * @example: "hello" + " world" -> "hello world"
	 */
	fn cat | + (other: string) -> string

	/**
	 * @brief: Repeats the string n times.
	 * @param n: The number of times to repeat
	 * @return A new string with this string repeated n times
	 * @example: "ab".repeat(3) -> "ababab"
	 * @example: "x".repeat(5) -> "xxxxx"
	 */
	fn repeat(n: u64) -> string

	/**
	 * @brief: Joins an array of strings with this string as separator.
	 * @param parts: Array of strings to join
	 * @return A new string with parts joined by this string
	 * @example: ",".join(["a", "b", "c"]) -> "a,b,c"
	 * @example: " - ".join(["hello", "world"]) -> "hello - world"
	 */
	fn join(parts: string[]) -> string

	// ============================================================
	// Validation & Checking
	// ============================================================

	/**
	 * @brief: Checks if the string is empty.
	 * @return true if length is 0, false otherwise
	 * @example: "".isEmpty() -> true
	 * @example: "hello".isEmpty() -> false
	 */
	fn isEmpty() -> bool

	/**
	 * @brief: Checks if the string contains only whitespace or is empty.
	 * @return true if string is empty or contains only whitespace
	 * @example: "   \t\n  ".isBlank() -> true
	 * @example: "  a  ".isBlank() -> false
	 */
	fn isBlank() -> bool

	/**
	 * @brief: Checks if the string contains only numeric characters.
	 * @return true if all characters are digits (0-9)
	 * @example: "12345".isNumeric() -> true
	 * @example: "123.45".isNumeric() -> false
	 */
	fn isNumeric() -> bool

	/**
	 * @brief: Checks if the string contains only alphabetic characters.
	 * @return true if all characters are letters (Unicode aware)
	 * @example: "hello".isAlpha() -> true
	 * @example: "hello123".isAlpha() -> false
	 */
	fn isAlpha() -> bool

	/**
	 * @brief: Checks if the string contains only alphanumeric characters.
	 * @return true if all characters are letters or digits
	 * @example: "hello123".isAlphaNumeric() -> true
	 * @example: "hello 123".isAlphaNumeric() -> false
	 */
	fn isAlphaNumeric() -> bool

	/**
	 * @brief: Checks if the string contains only lowercase characters.
	 * @return true if all alphabetic characters are lowercase
	 * @example: "hello".isLowerCase() -> true
	 * @example: "Hello".isLowerCase() -> false
	 */
	fn isLowerCase() -> bool

	/**
	 * @brief: Checks if the string contains only uppercase characters.
	 * @return true if all alphabetic characters are uppercase
	 * @example: "HELLO".isUpperCase() -> true
	 * @example: "Hello".isUpperCase() -> false
	 */
	fn isUpperCase() -> bool

	/**
	 * @brief: Checks if the string is valid UTF-8.
	 * @return true if the string is properly encoded UTF-8
	 */
	fn isValidUtf8() -> bool

	// ============================================================
	// Comparison
	// ============================================================

	/**
	 * @brief: Compares two strings lexicographically.
	 * @param other: The string to compare with
	 * @return Negative if this < other, 0 if equal, positive if this > other
	 * @example: "apple".compareTo("banana") -> negative
	 * @example: "hello".compareTo("hello") -> 0
	 */
	fn compareTo(other: string) -> i64

	/**
	 * @brief: Compares two strings case-insensitively.
	 * @param other: The string to compare with
	 * @return Negative if this < other, 0 if equal, positive if this > other
	 * @example: "Hello".compareToIgnoreCase("hello") -> 0
	 */
	fn compareToIgnoreCase(other: string) -> i64

	/**
	 * @brief: Checks if two strings are equal (case-sensitive).
	 * @param other: The string to compare with
	 * @return true if strings are identical
	 * @example: "hello".equals("hello") -> true
	 * @example: "hello".equals("Hello") -> false
	 */
	fn equals(other: string) -> bool

	/**
	 * @brief: Checks if two strings are equal (case-insensitive).
	 * @param other: The string to compare with
	 * @return true if strings are equal ignoring case
	 * @example: "Hello".equalsIgnoreCase("hello") -> true
	 */
	fn equalsIgnoreCase(other: string) -> bool

	// ============================================================
	// Conversion
	// ============================================================

	/**
	 * @brief: Creates a copy of the string.
	 * @return A new string with the same content
	 * @example: "hello".clone() -> "hello"
	 */
	fn clone() -> string

	/**
	 * @brief: Converts the string to a byte array.
	 * @return Array containing the UTF-8 encoded bytes
	 * @example: "hello".toBytes() -> [104, 101, 108, 108, 111]
	 */
	fn toBytes() -> u8[]

	/**
	 * @brief: Parses the string as an integer.
	 * @return The parsed integer value, or 0 if parsing fails
	 * @example: "123".toInt() -> 123
	 * @example: "-456".toInt() -> -456
	 */
	fn toInt() -> i64

	/**
	 * @brief: Parses the string as an unsigned integer.
	 * @return The parsed unsigned integer value, or 0 if parsing fails
	 * @example: "123".toUInt() -> 123
	 */
	fn toUInt() -> u64

	/**
	 * @brief: Parses the string as a floating point number.
	 * @return The parsed float value, or 0.0 if parsing fails
	 * @example: "123.45".toFloat() -> 123.45
	 * @example: "-3.14".toFloat() -> -3.14
	 */
	fn toFloat() -> f64

	/**
	 * @brief: Parses the string as a boolean.
	 * Recognizes "true", "false" (case-insensitive), "1", "0".
	 * @return The parsed boolean value, or false if parsing fails
	 * @example: "true".toBool() -> true
	 * @example: "FALSE".toBool() -> false
	 * @example: "1".toBool() -> true
	 */
	fn toBool() -> bool

	/**
	 * @brief: Converts the string to a UTF-16 encoded array.
	 * @return Array of u16 values representing UTF-16 encoding
	 */
	fn toUtf16() -> u16[]

	/**
	 * @brief: Converts the string to a UTF-32 encoded array.
	 * Each element represents a single Unicode code point.
	 * @return Array of u32 values representing Unicode code points
	 */
	fn toUtf32() -> u32[]

	// ============================================================
	// Hashing & Encoding
	// ============================================================

	/**
	 * @brief: Computes the hash code of the string.
	 * @return A hash value for the string
	 * @example: "hello".hashCode() -> some u64 value
	 */
	fn hashCode() -> u64

	/**
	 * @brief: Encodes the string to Base64.
	 * @return Base64 encoded string
	 * @example: "hello".toBase64() -> "aGVsbG8="
	 */
	fn toBase64() -> string

	/**
	 * @brief: Decodes the string from Base64.
	 * @return Decoded string, or empty string if invalid Base64
	 * @example: "aGVsbG8=".fromBase64() -> "hello"
	 */
	fn fromBase64() -> string

	/**
	 * @brief: URL encodes the string.
	 * Escapes special characters for use in URLs.
	 * @return URL encoded string
	 * @example: "hello world".urlEncode() -> "hello%20world"
	 */
	fn urlEncode() -> string

	/**
	 * @brief: URL decodes the string.
	 * Unescapes URL encoded characters.
	 * @return URL decoded string
	 * @example: "hello%20world".urlDecode() -> "hello world"
	 */
	fn urlDecode() -> string

	/**
	 * @brief: HTML encodes the string.
	 * Escapes HTML special characters.
	 * @return HTML encoded string
	 * @example: "<div>".htmlEncode() -> "&lt;div&gt;"
	 */
	fn htmlEncode() -> string

	/**
	 * @brief: HTML decodes the string.
	 * Unescapes HTML entities.
	 * @return HTML decoded string
	 * @example: "&lt;div&gt;".htmlDecode() -> "<div>"
	 */
	fn htmlDecode() -> string

	// ============================================================
	// Advanced Operations
	// ============================================================

	/**
	 * @brief: Reverses the string.
	 * Correctly handles multi-byte UTF-8 characters.
	 * @return A new string with characters in reverse order
	 * @example: "hello".reverse() -> "olleh"
	 * @example: "🎉🎊".reverse() -> "🎊🎉"
	 */
	fn reverse() -> string

	/**
	 * @brief: Counts occurrences of a substring.
	 * @param substring: The substring to count
	 * @return Number of non-overlapping occurrences
	 * @example: "hello world".count("o") -> 2
	 * @example: "aaa".count("aa") -> 1 (non-overlapping)
	 */
	fn count(substring: string) -> u64

	/**
	 * @brief: Normalizes Unicode string using specified form.
	 * @param form: Normalization form ("NFC", "NFD", "NFKC", "NFKD")
	 * @return Normalized string
	 * @example: "café".normalize("NFC") -> normalized form
	 */
	fn normalize(form: string) -> string

	/**
	 * @brief: Removes all occurrences of specified characters.
	 * @param chars: String containing characters to remove
	 * @return A new string with specified characters removed
	 * @example: "hello world".remove("lo") -> "he wrd"
	 */
	fn remove(chars: string) -> string

	/**
	 * @brief: Returns a string with only characters present in the allowed set.
	 * @param allowed: String containing allowed characters
	 * @return A new string with only allowed characters
	 * @example: "hello123world".filter("helo") -> "hellooll"
	 */
	fn filter(allowed: string) -> string

	/**
	 * @brief: Truncates string to maximum length with ellipsis.
	 * @param maxLength: Maximum length including ellipsis
	 * @return Truncated string with "..." if longer than maxLength
	 * @example: "hello world".truncate(8) -> "hello..."
	 * @example: "hi".truncate(10) -> "hi"
	 */
	fn truncate(maxLength: u64) -> string

	/**
	 * @brief: Truncates string to maximum length with custom suffix.
	 * @param maxLength: Maximum length including suffix
	 * @param suffix: Custom suffix to append (default: "...")
	 * @return Truncated string with suffix if longer than maxLength
	 * @example: "hello world".truncate(8, "…") -> "hello w…"
	 */
	fn truncate(maxLength: u64, suffix: string) -> string

	/**
	 * @brief: Extracts all matches of a regex pattern.
	 * @param pattern: The regex pattern to match
	 * @return Array of all matching substrings
	 * @example: "hello123world456".extractAll("[0-9]+") -> ["123", "456"]
	 */
	fn extractAll(pattern: string) -> string[]

	/**
	 * @brief: Indents each line of the string.
	 * @param spaces: Number of spaces to indent
	 * @return String with each line indented
	 * @example: "line1\nline2".indent(2) -> "  line1\n  line2"
	 */
	fn indent(spaces: u64) -> string

	/**
	 * @brief: Indents each line with a custom prefix.
	 * @param prefix: String to prepend to each line
	 * @return String with each line prefixed
	 * @example: "line1\nline2".indent(">> ") -> ">> line1\n>> line2"
	 */
	fn indent(prefix: string) -> string

	/**
	 * @brief: Removes common leading whitespace from all lines.
	 * @return String with common indentation removed
	 * @example: "  line1\n  line2".dedent() -> "line1\nline2"
	 */
	fn dedent() -> string

	/**
	 * Returns a C compatible string literal.
	 * @return A C compatible string literal
	 * @example: "hello".cstr() -> "hello\\0"
	 */
	fn cstr() -> u8[]
}
`;