import { InputHTMLAttributes, ReactNode, forwardRef } from "react";

interface InputFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helper?: string;
  icon?: ReactNode;
  optional?: boolean;
}

export const InputField = forwardRef<HTMLInputElement, InputFieldProps>(
  function InputField({ label, helper, icon, optional, className = "", ...props }, ref) {
    return (
      <div>
        {label && (
          <label className="block text-sm font-medium text-gray-300 mb-2">
            {icon && <span className="inline-flex items-center gap-1.5">{icon} {label}</span>}
            {!icon && label}
            {optional && (
              <span className="text-gray-500 font-normal ml-1">(optional)</span>
            )}
          </label>
        )}
        <input
          ref={ref}
          className={`glass-input ${className}`}
          {...props}
        />
        {helper && (
          <p className="text-xs text-gray-500 mt-1.5">{helper}</p>
        )}
      </div>
    );
  }
);
