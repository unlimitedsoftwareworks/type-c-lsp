/**
 * Example: Function calls with parameters
 * Demonstrates typed function calls with arg/return types.
 */

import { IRProgram, scalarType, toLIRFile } from '../ir/index.js';

export function runFuncCallDemo() {

    const program = new IRProgram();

    const i32 = scalarType('i32');

    // Create @add function with parameters
    const addFunc = program.createFunction(
        '@add',
        [
            { name: 'a', type: i32 },
            { name: 'b', type: i32 }
        ],
        [i32]
    );

    // result: i32 = add.i32 a b
    addFunc.add('result', 'a', 'b', 'i32');

    // ret result: i32
    addFunc.ret(['result'], [i32]);

    // Create @main function
    const main = program.createFunction('@main');

    // x: i32 = const_int 10
    main.constInt('x', 10, 'i32');

    // y: i32 = const_int 20
    main.constInt('y', 20, 'i32');

    // sum: i32 = call @add(x: i32, y: i32)
    main.call(['sum'], '@add', ['x', 'y'], [i32, i32], [i32]);

    // ret
    main.ret();

    // Generate .lir file
    console.log(toLIRFile(program));
}
