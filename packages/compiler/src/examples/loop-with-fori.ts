/**
 * Example: Loop using for_init/for_loop
 * Demonstrates numeric for-loop with accumulator.
 */

import { IRProgram, scalarType, toLIRFile } from '../ir/index.js';

export function forForDemo(){

    const program = new IRProgram();

    // Create @sum_1_to_10 function
    const sum1To10 = program.createFunction(
        '@sum_1_to_10',
        [],
        [scalarType('i32')]
    );

    // Initialize loop variables
    sum1To10.constInt('start', 1, 'i32');
    sum1To10.constInt('step', 1, 'i32');
    sum1To10.constInt('limit', 10, 'i32');

    // Initialize accumulator
    sum1To10.constInt('sum', 0, 'i32');

    // for_init base start limit step @loop_done
    sum1To10.forInit('base', 'start', 'limit', 'step', 'loop_done');

    // loop_body:
    sum1To10.label('loop_body');

    // sum = add.i32 sum base
    sum1To10.add('sum', 'sum', 'base', 'i32');

    // for_loop base @loop_done
    sum1To10.forLoop('base', 'loop_done');

    // loop_done:
    sum1To10.label('loop_done');

    // ret sum: i32
    sum1To10.ret(['sum'], [scalarType('i32')]);

    // Generate .lir file
    console.log(toLIRFile(program));
}
