import type { TypeCServices } from './type-c-module.js';
import { TypeCBaseValidation } from './validations/base-validation.js';

/**
 * Register custom validation checks.
 */
export function registerValidationChecks(services: TypeCServices) {
    const registry = services.validation.ValidationRegistry;
    const validations: TypeCBaseValidation[] = [
        services.validation.TypeSystemValidator,
        services.validation.FunctionOverloadValidator,
        services.validation.VariableUsageValidator
    ]
    for (const validation of validations) {
        registry.register(validation.getChecks(), validation);
    }
}
