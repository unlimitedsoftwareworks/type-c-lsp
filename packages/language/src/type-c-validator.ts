import type { TypeCServices } from './type-c-module.js';
import { TypeCBaseValidation } from './validations/base-validation.js';

/**
 * Register custom validation checks.
 */
export function registerValidationChecks(services: TypeCServices) {
    const registry = services.validation.ValidationRegistry;
    const validations: TypeCBaseValidation[] = [
        // Tier 2 (syntactic): unchanged
        services.validation.VariableUsageValidator,
        services.validation.DuplicateValidator,
        services.validation.VariableInitializerValidator,
        services.validation.ControlFlowValidator,
        // Structural validators (no/minimal getType calls)
        services.validation.StaticContextValidator,
        services.validation.OverloadValidator,
        // Single entry point for type-dependent validation (collector + inference store)
        services.validation.TypeDiagnosticsValidator,
    ]
    for (const validation of validations) {
        registry.register(validation.getChecks(), validation);
    }
}
