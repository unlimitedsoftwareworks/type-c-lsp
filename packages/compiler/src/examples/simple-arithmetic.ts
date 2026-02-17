/**
 * Example: Simple arithmetic using the IR API
 * Demonstrates typed arithmetic operations with i32.
 */

import { IRProgram, toLIRFile } from '../ir/index.js';

export function runArithemeticDemo(){

    const program = new IRProgram();

    // Create @main function
    const main = program.createFunction('@main');

    // a: i32 = const_int 10
    main.constInt('a', 10, 'i32');

    // b: i32 = const_int 20
    main.constInt('b', 20, 'i32');

    // sum: i32 = add.i32 a b
    main.add('sum', 'a', 'b', 'i32');

    // diff: i32 = sub.i32 a b
    main.sub('diff', 'a', 'b', 'i32');

    // prod: i32 = mul.i32 a b
    main.mul('prod', 'a', 'b', 'i32');

    // quot: i32 = div.i32 a b
    main.div('quot', 'a', 'b', 'i32');

    // ret
    main.ret();

    // Generate .lir file
    console.log(toLIRFile(program));
}
