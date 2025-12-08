/**
 * (c) Copyright 2025 Soulaymen Chouri.
 * This software is licensed under the Apache License 2.0.
 * See the LICENSE.md file in the project root for details.
 */

/**
 * This file defines enums for the warnings that can be emitted by the TypeC language.
 */
export enum WarningCode {
    TCW001 = 'CLASS_NAME_SHOULD_START_WITH_CAPITAL',
    
    // Cast Expression Warnings (TCW010-TCW019)
    TC_CAST_UNNECESSARY_SAFE_CAST = 'TCW010',
    TC_CAST_UNNECESSARY_FORCE_CAST = 'TCW011',
    TC_CAST_DANGEROUS_FORCE_CAST = 'TCW012',
    TC_CAST_SAFE_CAST_ALWAYS_NULL = 'TCW013',
    TC_CAST_SAFE_CAST_ALWAYS_SUCCEEDS = 'TCW014',
    TC_CAST_SAFE_CAST_WITH_PRIMITIVE = 'TCW015',
}

/**
 * Info codes for helpful notifications that don't indicate problems.
 */
export enum InfoCode {
    TYPE_SHADOWS_IMPORTED_MODULE = 'TCI001',
}