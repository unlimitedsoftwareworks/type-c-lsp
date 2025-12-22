/**
 * Example: Function calls with parameters
 * Recreates examples/05-function-calls.lir
 */

import { LIRProgram, basicType, intLiteral, toLIRFile } from '../ir/index.js';

export function runFuncCallDemo() {
    
    const program = new LIRProgram();
    
    // Create @add function with parameters
    const addFunc = program.createFunction(
        '@add',
        [
            { name: 'a', type: basicType('i32') },
            { name: 'b', type: basicType('i32') }
        ],
        basicType('i32') // return type
    );
    
    // result: int = add a b;
    addFunc.add('result', 'a', 'b', basicType('i32'));
    
    // ret result;
    addFunc.ret('result');
    
    // Create @main function
    const main = program.createFunction('@main');
    
    // x: int = const 10;
    main.const('x', intLiteral(10), basicType('i32'));
    
    // y: int = const 20;
    main.const('y', intLiteral(20), basicType('i32'));
    
    // sum: int = call @add x y;
    main.call('@add', ['x', 'y'], 'sum', basicType('i32'));
    
    // ret;
    main.ret();
    
    // Generate .lir file
    console.log(toLIRFile(program));
}