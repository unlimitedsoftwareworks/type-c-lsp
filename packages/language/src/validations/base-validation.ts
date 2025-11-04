import { ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";

export abstract class TypeCBaseValidation {
    /**
     * For a unified validation approach, all validation classes should inherit from this class.
     * This method should return the checks needed for the validation class.
     * such as {Node: [check1, check2]}
     */
    abstract getChecks(): ValidationChecks<ast.TypeCAstType>;
}