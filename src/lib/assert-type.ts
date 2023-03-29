export function assertNumber(varName: string, value: any): asserts value is number {
    if (typeof value != 'number' || isNaN(value))
    throw _typeError(varName, 'number', value);
}

export function assertBigint(varName: string, value: any): asserts value is bigint {
    if (typeof value != 'bigint')
    throw _typeError(varName, 'bigint', value);
}

export function assertString(varName: string, value: any, minLength = 0, maxLength = Infinity): asserts value is string {
    if (typeof value != 'string')
    throw _typeError(varName, 'string', value);

    if (value.length < minLength || value.length > maxLength)
    throw new TypeError(`${varName} must be between ${minLength} and ${maxLength} characters long`);
}

export function assertInstanceOf(type: Function, varName: string, value: any): asserts value is typeof type {
    if (!(value instanceof type))
    throw _typeError(varName, _typeName(type), value);
}

function _typeError(varName: string, requiredType: string, value: any): TypeError {
    return new TypeError(`${varName} should be type ${requiredType}, got ${_typeName(value)} instead`);
}
function _typeName(value: any): string {
    let type = typeof value;
    if (type == 'object') type += ` ${value.constructor.name}`;
    return type;
}
