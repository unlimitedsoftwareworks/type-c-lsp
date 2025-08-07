import type { ValidationAcceptor, ValidationChecks } from 'langium';
import * as ast from './generated/ast.js';
import type { TypeCServices } from './type-c-module.js';
import { WarningCode } from './codes/warnings.js';

/**
 * Register custom validation checks.
 */
export function registerValidationChecks(services: TypeCServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.TypeCValidator;
    const checks: ValidationChecks<ast.TypeCAstType> = {
        TypeDeclaration: [validator.checkClassStartsWithCapital]
    };
    registry.register(checks, validator);
}

/**
 * Implementation of custom validations.
 */
export class TypeCValidator {
    // WCW001: Check that the class name starts with a capital.
    checkClassStartsWithCapital(node: ast.TypeDeclaration, accept: ValidationAcceptor): void {
        if(ast.isClassType(node.definition)) {
            // Make sure that the class name starts with a capital
            const firstChar = node.name.substring(0, 1);
            if (firstChar.toUpperCase() !== firstChar) {
                accept('warning', WarningCode.TCW001, { node: node, property: 'name', code: WarningCode.TCW001 });
            }
        }
    }
}
