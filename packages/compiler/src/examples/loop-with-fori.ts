/**
 * Example: Loop using fori/forl
 * Recreates examples/14-sum-with-fori.lir
 */

import { LIRProgram, basicType, intLiteral, toLIRFile } from '../ir/index.js';

export function forForDemo(){
    
    const program = new LIRProgram();
    
    // Create @sum_1_to_10 function
    const sum1To10 = program.createFunction('@sum_1_to_10');
    
    // Initialize loop variables
    sum1To10.const('start', intLiteral(1), basicType('i32'));
    sum1To10.const('step', intLiteral(1), basicType('i32'));
    sum1To10.const('i', intLiteral(1), basicType('i32'));
    
    // Initialize accumulator
    sum1To10.const('sum', intLiteral(0), basicType('i32'));
    
    // fori .loop_body start i step .loop_done;
    sum1To10.fori('.loop_body', 'start', 'i', 'step', '.loop_done');
    
    // .loop_body:
    sum1To10.label('.loop_body');
    
    // sum = add sum i;
    sum1To10.add('sum', 'sum', 'i');
    
    // forl .loop_body start i step .loop_done;
    sum1To10.forl('.loop_body', 'start', 'i', 'step', '.loop_done');
    
    // .loop_done:
    sum1To10.label('.loop_done');
    
    // ret sum;
    sum1To10.ret('sum');
    
    // Generate .lir file
    console.log(toLIRFile(program));
}