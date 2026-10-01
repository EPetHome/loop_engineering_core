import sys
if sys.argv[1] == 'front':
    from frontend import payload
    assert payload() == {'invite_code': 'ABC'}, payload()
elif sys.argv[1] == 'back':
    from backend import accept
    assert accept({'invite_code': 'ABC'}) is True
else:
    from frontend import payload
    from backend import accept
    assert accept(payload()) is True
print('CHECK PASSED:', sys.argv[1])
