import { ValidationAcceptor, ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";
import { ErrorCode } from "../codes/errors.js";
import { TypeCBaseValidation } from "./base-validation.js";

/**
 * Validates that all variable declarations have initializers.
 * 
 * The grammar makes initializers optional for better error recovery when parsing,
 * but semantically all variables must be initialized at declaration time.
 * 
 * This validation checks:
 * 1. VariableDeclSingle - simple variable declarations
 * 2. VariableDeclArrayDestructuring - array destructuring declarations
 * 3. VariableDeclStructDestructuring - struct destructuring declarations
 * 4. VariableDeclTupleDestructuring - tuple destructuring declarations
 */
export class TypeCVariableInitializerValidator extends TypeCBaseValidation {
    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            VariableDeclSingle: this.checkVariableDeclSingleInitializer,
            VariableDeclArrayDestructuring: this.checkVariableDeclArrayDestructuringInitializer,
            VariableDeclStructDestructuring: this.checkVariableDeclStructDestructuringInitializer,
            VariableDeclTupleDestructuring: this.checkVariableDeclTupleDestructuringInitializer,
        };
    }

    /**
     * Check if a single variable declaration has an initializer.
     */
    private checkVariableDeclSingleInitializer = (
        node: ast.VariableDeclSingle,
        accept: ValidationAcceptor
    ): void => {
        if (!node.initializer) {
            const errorCode = ErrorCode.TC_VARIABLE_MISSING_INITIALIZER;
            accept('error',
                `Variable declaration error: Variable '${node.name}' must have an initializer. All variables must be initialized at declaration.`,
                { node, code: errorCode }
            );
        }
    }

    /**
     * Check if an array destructuring declaration has an initializer.
     */
    private checkVariableDeclArrayDestructuringInitializer = (
        node: ast.VariableDeclArrayDestructuring,
        accept: ValidationAcceptor
    ): void => {
        if (!node.initializer) {
            const errorCode = ErrorCode.TC_VARIABLE_MISSING_INITIALIZER;
            accept('error',
                `Variable declaration error: Array destructuring must have an initializer. All variables must be initialized at declaration.`,
                { node, code: errorCode }
            );
        }
    }

    /**
     * Check if a struct destructuring declaration has an initializer.
     */
    private checkVariableDeclStructDestructuringInitializer = (
        node: ast.VariableDeclStructDestructuring,
        accept: ValidationAcceptor
    ): void => {
        if (!node.initializer) {
            const errorCode = ErrorCode.TC_VARIABLE_MISSING_INITIALIZER;
            accept('error',
                `Variable declaration error: Struct destructuring must have an initializer. All variables must be initialized at declaration.`,
                { node, code: errorCode }
            );
        }
    }

    /**
     * Check if a tuple destructuring declaration has an initializer.
     */
    private checkVariableDeclTupleDestructuringInitializer = (
        node: ast.VariableDeclTupleDestructuring,
        accept: ValidationAcceptor
    ): void => {
        if (!node.initializer) {
            const errorCode = ErrorCode.TC_VARIABLE_MISSING_INITIALIZER;
            accept('error',
                `Variable declaration error: Tuple destructuring must have an initializer. All variables must be initialized at declaration.`,
                { node, code: errorCode }
            );
        }
    }
}