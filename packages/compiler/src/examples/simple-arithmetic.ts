/**
 * Example: Simple arithmetic using the LIR API
 * Recreates examples/01-basic-arithmetic.lir
 */

import { LIRProgram, basicType, intLiteral, toLIRFile } from '../ir/index.js';

export function runArithemeticDemo(){
    
    const program = new LIRProgram();
    
    // Create @main function
    const main = program.createFunction('@main');
    
    // a: int = const 10;
    main.const('a', intLiteral(10), basicType('i32'));
    
    // b: int = const 20;
    main.const('b', intLiteral(20), basicType('i32'));
    
    // sum: int = add a b;
    main.add('sum', 'a', 'b', basicType('i32'));
    
    // diff: int = sub a b;
    main.sub('diff', 'a', 'b', basicType('i32'));
    
    // prod: int = mul a b;
    main.mul('prod', 'a', 'b', basicType('i32'));
    
    // quot: int = div a b;
    main.div('quot', 'a', 'b', basicType('i32'));
    
    // ret;
    main.ret();
    
    // Generate .lir file
    console.log(toLIRFile(program));
}