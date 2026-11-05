$title Exec error + odd chars
Scalar z /0/, y;
$log unicode: üß ✓ tab:	here and bell done
$log esc:[31mred[0m end
y = 1/z;
Display y;
abort$(y=y) "custom abort message";
